
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const { uploadGTFS } = require("../controllers/gtfsController");

const router = express.Router();

const uploadDir = path.join(__dirname, "../../data/uploads");

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `gtfs-${Date.now()}-${Math.round(Math.random() * 1e9)}.zip`);
    }
});

// // const upload = multer({
// //     storage,
// //     limits: {
// //         fileSize: 50 * 1024 * 1024,
// //         files: 1
// //     },
//     fileFilter: (req, file, cb) => {
//         if (path.extname(file.originalname).toLowerCase() !== ".zip") {
//             return cb(new Error("Only ZIP files are allowed"));
//         }
//         cb(null, true);
//     }
// });
const upload = multer({
    storage,
    limits: {
        fileSize: 50 * 1024 * 1024,
        files: 1
    }
});

router.post("/import", upload.single("gtfs"), uploadGTFS);

module.exports = router;
