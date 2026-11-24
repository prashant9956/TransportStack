const mongoose = require("mongoose");

const serviceExceptionSchema = new mongoose.Schema({
    serviceId: {
        type: String,
        required: true
    },
    exceptionDate: {
        type: String,
        required: true
    },
    exceptionType: {
        type: Number,
        required: true,
        enum: [1, 2]
    }
}, { timestamps: true });

serviceExceptionSchema.index(
    { serviceId: 1, exceptionDate: 1 },
    { unique: true }
);

module.exports = mongoose.model(
    "ServiceException",
    serviceExceptionSchema
);