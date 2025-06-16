const express = require("express");
const { Sequelize, DataTypes } = require("sequelize");
const session = require("express-session");
const cors = require("cors");
const bodyParser = require("body-parser");
const upnp = require("nat-upnp");
const path = require("path");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const fetch = require("node-fetch");
const client = upnp.createClient();

const app = express();
const PORT = 3000;

const Bottleneck = require("bottleneck");

const limiter = new Bottleneck({ minTime: 10 * 1000 }); // 1-minute delay between executions

// Database setup
const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: "./data/portmapper.sqlite",
  logging: false
});

const User = sequelize.define("User", {
  username: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false
  },
  isAdmin: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
});

const PortMapping = sequelize.define("PortMapping", {
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  internalPort: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  externalPort: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  protocol: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "TCP"
  }
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(
  session({
    secret: "supersecretkey",
    resave: false,
    saveUninitialized: true
  })
);

// Initialize DB and create default admin
async function initDB() {
  await sequelize.sync();
  const adminExists = await User.findOne({ where: { username: "admin" } });
  if (!adminExists) {
    const hashedPassword = await bcrypt.hash("admin", 10);
    await User.create({
      username: "admin",
      password: hashedPassword,
      isAdmin: true
    });
  }
}
initDB();

async function forwardPort(name, internalPort, externalPort, protocol = "TCP") {
  return new Promise(async (resolve, reject) => {
    client.portMapping(
      {
        public: externalPort,
        private: internalPort,
        protocol: protocol,
        ttl: 3600
      },
      async err => {
        if (err) {
          console.error(`Failed to forward port ${externalPort}:`, err);
          reject(err);
        } else {
          console.log(`Port ${externalPort} forwarded successfully.`);
          // Check if the external port is already in use
          const existingMapping = await PortMapping.findOne({
            where: {
              externalPort,
              protocol: protocol || "TCP"
            }
          });

          if (existingMapping) {
            return resolve();
          } else {
            await PortMapping.create({
              name,
              internalPort,
              externalPort,
              protocol
            });
            resolve();
          }
        }
      }
    );
  });
}

/**
 * Check if a TCP or UDP port is open on a given host.
 * @param {string} host - The IP address or hostname to check.
 * @param {number} port - The port number to check.
 * @param {string} protocol - "tcp" or "udp".
 * @param {number} timeout - Timeout in milliseconds (default: 3000ms).
 * @returns {Promise<boolean>} - Resolves true if the port is open, false otherwise.
 */
async function isPortOpen(host, port, protocol = "TCP", timeout = 3000) {
  return new Promise(async resolve => {
    const myHeaders = new fetch.Headers();
    myHeaders.append("Content-Type", "application/json");

    const raw = JSON.stringify({
      host: host,
      port: Number(port),
      protocol: protocol,
      timeout: timeout
    });

    const requestOptions = {
      method: "POST",
      headers: myHeaders,
      body: raw,
      redirect: "follow"
    };

    var portchecker = await fetch(
      "https://api.nekosunevr.co.uk/v5/proxy/portchecker",
      requestOptions
    ).then(res => res.json());
    resolve(portchecker.open);
  });
}

async function getExternalIP() {
  return new Promise((resolve, reject) => {
    const client = upnp.createClient();
    client.externalIp((err, ip) => {
      if (err) {
        console.error("Failed to get external IP via UPnP:", err.message);
        return resolve(null);
      }
      resolve(ip);
    });
  });
}

async function checkPorts() {
  try {
    const externalIP = await getExternalIP();
    if (!externalIP) {
      console.error("Skipping port check due to missing external IP.");
      return;
    }

    const mappings = await PortMapping.findAll();
    for (const { name, internalPort, externalPort, protocol } of mappings) {
      const portIsOpen = await isPortOpen(externalIP, externalPort, protocol);

      if (!portIsOpen) {
        console.log(`Port ${externalPort} (${name}) is closed, reopening...`);
        await retryForwardPort(name, internalPort, externalPort, protocol, 3);
      }
    }
  } catch (err) {
    console.error("Failed to retrieve port mappings:", err.message);
  }
}

async function retryForwardPort(
  name,
  internalPort,
  externalPort,
  protocol,
  retries
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await forwardPort(name, internalPort, externalPort, protocol);
      console.log(
        `Successfully forwarded port ${externalPort} on attempt ${attempt}`
      );
      return;
    } catch (err) {
      console.warn(
        `Attempt ${attempt} to forward port ${externalPort} failed:`,
        err.message
      );
      forwardPort(name, internalPort, externalPort, protocol)
      if (attempt === retries) {
        console.error(
          `Failed to forward port ${externalPort} after ${retries} attempts.`
        );
      } else {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait before retrying
      }
    }
  }
}

// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// Serve HTML files
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serve HTML files
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/port-check", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "status.html"));
});

// Serve HTML files
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Routes
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ where: { username } });

  if (user && (await bcrypt.compare(password, user.password))) {
    req.session.user = { username: user.username, isAdmin: user.isAdmin };
    res.json({ success: true, isAdmin: user.isAdmin });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/users", isAuthenticated, async (req, res) => {
  const users = await User.findAll({ attributes: ["username", "isAdmin"] });
  res.json(users);
});

app.post("/create-user", isAuthenticated, async (req, res) => {
  if (!req.session.user.isAdmin)
    return res.status(403).json({ error: "Forbidden" });

  const { username, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    await User.create({ username, password: hashedPassword });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: "User already exists" });
  }
});

app.delete("/remove-user", isAuthenticated, async (req, res) => {
  if (!req.session.user.isAdmin)
    return res.status(403).json({ error: "Forbidden" });

  const { username } = req.query;
  if (username === "admin")
    return res.status(400).json({ error: "Cannot delete admin" });

  await User.destroy({ where: { username } });
  res.json({ success: true });
});

app.post("/change-admin-password", isAuthenticated, async (req, res) => {
  if (req.session.user.username !== "admin")
    return res.status(403).json({ error: "Forbidden" });

  const { password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  await User.update(
    { password: hashedPassword },
    { where: { username: "admin" } }
  );

  res.json({ success: true });
});

app.get("/admin-password-status", isAuthenticated, async (req, res) => {
  const admin = await User.findOne({ where: { username: "admin" } });
  const isDefaultPassword = await bcrypt.compare("admin", admin.password);
  res.json({ changed: !isDefaultPassword });
});

app.get("/forward", isAuthenticated, async (req, res) => {
  const { name, internalPort, externalPort, protocol } = req.query;
  if (!name || !internalPort || !externalPort) {
    return res
      .status(400)
      .send("Missing name, internalPort, or externalPort parameter.");
  }
  try {
    await forwardPort(
      name,
      parseInt(internalPort),
      parseInt(externalPort),
      protocol || "TCP"
    );
    res.send(`Port ${externalPort} (${name}) forwarded successfully.`);
  } catch (err) {
    res.status(500).send(`Failed to forward port ${externalPort}.`);
  }
});

app.get("/list", isAuthenticated, async (req, res) => {
  const mappings = await PortMapping.findAll();
  res.json(mappings);
});

app.delete("/remove", isAuthenticated, async (req, res) => {
  const { externalPort, protocol } = req.query;
  if (!externalPort) {
    return res.status(400).send("Missing externalPort parameter.");
  }
  try {
    await PortMapping.destroy({
      where: { externalPort: parseInt(externalPort), protocol: protocol }
    });
    res.send(`Port ${externalPort} removed successfully.`);
  } catch (err) {
    res.status(500).send(`Failed to remove port ${externalPort}.`);
  }
});

// Get port status
app.get("/port-status", isAuthenticated, async (req, res) => {
  try {
    const rows = await PortMapping.findAll();
    const externalIP = await getExternalIP();
    if (!externalIP) {
      console.error("Skipping port check due to missing external IP.");
      return;
    }
    const portStatuses = await Promise.all(
      rows.map(async row => {
        const isOpen = await isPortOpen(
          externalIP,
          row.externalPort,
          row.protocol
        );
        return { ...row.toJSON(), open: isOpen };
      })
    );
    res.json(portStatuses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

setInterval(() => {
  limiter.schedule(checkPorts)
}, 10 * 1000);

sequelize.sync().then(async () => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`UPnP Port Manager running on http://127.0.0.1:${PORT}`);
  });
});
