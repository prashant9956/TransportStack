
const mongoose = require("mongoose");

const tripSchema = new mongoose.Schema({
    tripId: {
        type: String,
        required: true,
        unique: true
    },
    routeId: {
        type: String,
        required: true
    },
    serviceId: String,
    tripHeadsign: String,
    directionId: Number,
    shapeId: String
}, { timestamps: true });

module.exports = mongoose.model("Trip", tripSchema);
