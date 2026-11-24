
const fs = require("fs/promises");
const importGTFS = require("../services/gtfsImportService");

const uploadGTFS = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: "Please upload a GTFS ZIP file"
        });
    }

    try {
        // Pass file path instead of loading ZIP into RAM
        const result = await importGTFS(req.file.path);

        return res.status(200).json({
            success: true,
            message: "GTFS data imported successfully",
            importedRecords: result
        });

    } catch (error) {
        console.error("GTFS Import Error:", error);

        return res.status(400).json({
            success: false,
            message: error.message
        });

    } finally {
        // Delete uploaded ZIP after processing
        try {
            await fs.unlink(req.file.path);
        } catch (cleanupError) {
            console.error("Upload cleanup error:", cleanupError.message);
        }
    }
};

module.exports = { uploadGTFS };
