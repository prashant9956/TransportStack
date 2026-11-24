const express = require("express");
const router = express.Router();

const { getTripShape } = require("../controllers/shapeController");

// Get complete trip route coordinates
router.get("/trips/:tripId/shape", getTripShape);

module.exports = router;