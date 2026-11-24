
const express = require("express");
const dotenv = require("dotenv");

const cors = require("cors");
const path = require("path");


dotenv.config();
const app = express();
const gtfsRoutes = require("./src/routes/gtfsRoutes");
const realtimeRoutes = require("./src/routes/realtimeRoutes");
const shapeRoutes = require("./src/routes/shapeRoutes");

// Import database connection
const connectDB = require("./src/config/db");

// Import routes
const routeRoutes = require("./src/routes/routeRoutes");

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, "public")));
// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// API Routes
app.use("/api/routes", routeRoutes);
app.use("/api/gtfs", gtfsRoutes);
app.use("/api/realtime", realtimeRoutes);
app.use("/api/shapes", shapeRoutes);

app.get("/live-map", (req, res) => {
    res.render("liveMap");
});
app.get("/journey-planner", (req, res) => {
    res.render("journeyPlanner");
});
app.get("/nearest-stops", (req, res) => {
    res.render("nearestStops");
});

app.get("/trip-map", (req, res) => {
    res.render("tripMap");
});

// Home route
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Welcome to TransportStack API",
        project: "TransportStack",
        status: "Running"
    });
});

// Health API
app.get("/api/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "TransportStack server is healthy",
        timestamp: new Date()
    });
});

// Start server
const PORT = process.env.PORT || 8080;

const startServer = async () => {
    try {
        await connectDB();

        app.listen(PORT, () => {
            console.log(`TransportStack running on port ${PORT}`);
            console.log(`http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error("Server startup failed:", error.message);
        process.exit(1);
    }
};

startServer();
