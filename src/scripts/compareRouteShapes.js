const fs = require("fs");
const csv = require("csv-parser");

const ids = new Set(["shp_3_3419", "shp_3_3418", "shp_3_2316"]);
const shapes = new Map();

function distance(a, b) {
  const R = 6371;
  const rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

fs.createReadStream("data/gtfs/delhi_buses_static_gtfs_v1/shapes.txt")
  .pipe(csv())
  .on("data", row => {
    if (!ids.has(row.shape_id)) return;
    if (!shapes.has(row.shape_id)) shapes.set(row.shape_id, []);
    shapes.get(row.shape_id).push({
      lat: Number(row.shape_pt_lat),
      lng: Number(row.shape_pt_lon),
      seq: Number(row.shape_pt_sequence)
    });
  })
  .on("end", () => {
    const endpoints = {};

    for (const [id, points] of shapes) {
      points.sort((a, b) => a.seq - b.seq);
      let km = 0;
      for (let i = 1; i < points.length; i++) {
        km += distance(points[i - 1], points[i]);
      }

      endpoints[id] = {
        first: points[0],
        last: points[points.length - 1]
      };

      console.log(id, "points:", points.length, "lengthKm:", km.toFixed(2));
    }

    console.log("\nENDPOINT DISTANCES (km)");
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b || !endpoints[a] || !endpoints[b]) continue;
        console.log(
          a, "<->", b,
          "start-start:", distance(endpoints[a].first, endpoints[b].first).toFixed(3),
          "end-end:", distance(endpoints[a].last, endpoints[b].last).toFixed(3),
          "A-end to B-start:", distance(endpoints[a].last, endpoints[b].first).toFixed(3),
          "A-start to B-end:", distance(endpoints[a].first, endpoints[b].last).toFixed(3)
        );
      }
    }
  });
