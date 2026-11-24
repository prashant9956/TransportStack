
const mongoose = require("mongoose");

const shapeSchema = new mongoose.Schema({
    shapeId: {
        type: String,
        required: true
    },
    shapePtLat: {
        type: Number,
        required: true
    },
    shapePtLon: {
        type: Number,
        required: true
    },
    shapePtSequence: {
        type: Number,
        required: true
    },
    shapeDistTraveled: {
        type: Number,
        default: 0
    }
}, { timestamps: true });

shapeSchema.index(
    { shapeId: 1, shapePtSequence: 1 },
    { unique: true }
);

module.exports = mongoose.model("Shape", shapeSchema);
