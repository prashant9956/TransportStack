
const fs = require("fs");
const csv = require("csv-parser");
const Shape = require("../models/shape");

const BATCH_SIZE = 1000;

async function importShapes(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Shapes file not found: ${filePath}`);
    }

    return new Promise((resolve, reject) => {
        let batch = [];
        let totalRows = 0;
        let rejected = 0;
        let saved = 0;

        const stream = fs.createReadStream(filePath).pipe(csv());

        async function saveBatch() {
            if (!batch.length) return;

            const operations = batch.map(doc => ({
                updateOne: {
                    filter: {
                        shapeId: doc.shapeId,
                        shapePtSequence: doc.shapePtSequence
                    },
                    update: { $set: doc },
                    upsert: true
                }
            }));

            const result = await Shape.bulkWrite(operations, {
                ordered: false
            });

            saved += operations.length;

            console.log("Shapes batch saved:", {
                batchSize: operations.length,
                upserted: result.upsertedCount,
                modified: result.modifiedCount
            });

            batch = [];
        }

        stream.on("data", row => {
            stream.pause();

            (async () => {
                totalRows++;

                const lat = Number(row.shape_pt_lat);
                const lon = Number(row.shape_pt_lon);
                const sequence = Number(row.shape_pt_sequence);
                const distance = Number(row.shape_dist_traveled || 0);

                if (
                    !row.shape_id ||
                    !Number.isFinite(lat) ||
                    !Number.isFinite(lon) ||
                    !Number.isFinite(sequence) ||
                    lat < -90 || lat > 90 ||
                    lon < -180 || lon > 180
                ) {
                    rejected++;
                    return;
                }

                batch.push({
                    shapeId: row.shape_id,
                    shapePtLat: lat,
                    shapePtLon: lon,
                    shapePtSequence: sequence,
                    shapeDistTraveled: distance
                });

                if (batch.length >= BATCH_SIZE) {
                    await saveBatch();
                }
            })()
            .then(() => stream.resume())
            .catch(error => stream.destroy(error));
        });

        stream.on("end", async () => {
            try {
                await saveBatch();

                const summary = {
                    totalRows,
                    saved,
                    rejected
                };

                console.log("Shapes import completed:", summary);
                resolve(summary);
            } catch (error) {
                reject(error);
            }
        });

        stream.on("error", error => {
            reject(error);
        });
    });
}

module.exports = importShapes;
