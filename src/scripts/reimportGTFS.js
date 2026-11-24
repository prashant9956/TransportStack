
require("dotenv").config();

const path = require("path");
const connectDB = require("../config/db");
const importGTFS = require("../services/gtfsImportService");

async function startImport() {
    try {
        await connectDB();

        const folderPath = path.resolve(
            __dirname,
            "../../data/gtfs/delhi_buses_static_gtfs_v1"
        );

        console.log("GTFS folder:", folderPath);

        const result = await importGTFS(folderPath);

        console.log("\nGTFS RE-IMPORT COMPLETED SUCCESSFULLY");
        console.log(result);

        process.exit(0);
    } catch (error) {
        console.error("GTFS RE-IMPORT FAILED:", error);
        process.exit(1);
    }
}

startImport();
