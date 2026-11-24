
const mongoose = require("mongoose");

const agencySchema = new mongoose.Schema({
    agencyId: {
        type: String,
        required: true,
        unique: true
    },
    agencyName: {
        type: String,
        required: true
    },
    agencyUrl: String,
    agencyTimezone: String,
    agencyPhone: String
}, { timestamps: true });

module.exports = mongoose.model("Agency", agencySchema);
