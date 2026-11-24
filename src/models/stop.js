
const mongoose = require("mongoose");

const stopSchema = new mongoose.Schema({
    stopId: {
        type: String,
        required: true,
        unique: true
    },
    stopName: {
        type: String,
        required: true
    },
    stopLat: {
        type: Number,
        required: true
    },
    stopLon: {
        type: Number,
        required: true
    },
    locationType: Number,
    parentStation: String
}, { timestamps: true });

module.exports = mongoose.model("Stop", stopSchema);
