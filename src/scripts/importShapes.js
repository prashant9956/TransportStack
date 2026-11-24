
require("dotenv").config();

const connectDB = require("../config/db");
const importShapes = require("../services/shapeImportService");

const path = require("path");

async function startImport() {
    try {
        await connectDB();

        const filePath = path.join(
            __dirname,
            "../../data/gtfs/delhi_buses_static_gtfs_v1/shapes.txt"
        );

        await importShapes(filePath);

        console.log("Shapes import process finished.");

        process.exit(0);
    } catch (error) {
        console.error("Shapes import failed:", error);
        process.exit(1);
    }
}

startImport();
