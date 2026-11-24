
const mongoose = require("mongoose");

const stopTimeSchema = new mongoose.Schema({
    tripId: {
        type: String,
        required: true
    },
    arrivalTime: String,
    departureTime: String,
    stopId: {
        type: String,
        required: true
    },
    stopSequence: {
        type: Number,
        required: true
    }
}, { timestamps: true });

stopTimeSchema.index({ tripId: 1, stopSequence: 1 });
stopTimeSchema.index({ stopId: 1 });

module.exports = mongoose.model("StopTime", stopTimeSchema);
