"""Regenerate docs/ geo data (county GeoJSON + TopoJSON, state TopoJSON).

Sources (repo root):
  county_web.geojson.gz   WGS84,    properties.county_geoid (FIPS5)
  geometry__state.geojson EPSG:5070, properties.state_fips

Outputs (docs/):
  us-counties-2023.json       GeoJSON FeatureCollection (legacy fallback)
  us-counties-2023-topo.json  TopoJSON, objects.counties
  states-10m.json             TopoJSON, objects.states (reprojected to WGS84)
"""

import gzip
import json
import os
import sys

import topojson as tp
from pyproj import Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform as shp_transform

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")


def build_counties():
    src = os.path.join(ROOT, "county_web.geojson.gz")
    with gzip.open(src, "rt") as f:
        fc = json.load(f)

    fc.pop("crs", None)
    fc.pop("name", None)

    out_features = []
    for feat in fc["features"]:
        props = feat.get("properties", {}) or {}
        geoid = props.get("county_geoid")
        if geoid is None:
            continue
        fid = str(geoid).zfill(5)
        out_features.append(
            {
                "type": "Feature",
                "id": fid,
                "properties": {"county_geoid": fid},
                "geometry": feat["geometry"],
            }
        )

    out_fc = {"type": "FeatureCollection", "features": out_features}

    geojson_path = os.path.join(DOCS, "us-counties-2023.json")
    with open(geojson_path, "w") as f:
        json.dump(out_fc, f, separators=(",", ":"))
    print(f"wrote {geojson_path} ({len(out_features)} features)")

    topo = tp.Topology(out_fc, prequantize=int(1e6), object_name="counties").to_json()
    topo_path = os.path.join(DOCS, "us-counties-2023-topo.json")
    with open(topo_path, "w") as f:
        f.write(topo)
    print(f"wrote {topo_path}")


def build_states():
    src = os.path.join(ROOT, "geometry__state.geojson")
    with open(src) as f:
        fc = json.load(f)

    fc.pop("crs", None)
    fc.pop("name", None)

    transformer = Transformer.from_crs("EPSG:5070", "EPSG:4326", always_xy=True)

    out_features = []
    for feat in fc["features"]:
        props = feat.get("properties", {}) or {}
        fips = props.get("state_fips")
        if fips is None:
            continue
        try:
            fid = int(fips)
        except (TypeError, ValueError):
            continue

        geom = shape(feat["geometry"])
        geom_wgs = shp_transform(transformer.transform, geom)

        out_features.append(
            {
                "type": "Feature",
                "id": fid,
                "properties": {
                    "state_fips": str(fips).zfill(2),
                    "state_name": props.get("state_name"),
                    "state_abbreviation": props.get("state_abbreviation"),
                },
                "geometry": mapping(geom_wgs),
            }
        )

    out_fc = {"type": "FeatureCollection", "features": out_features}

    topo = tp.Topology(out_fc, prequantize=int(1e6), object_name="states").to_json()
    topo_path = os.path.join(DOCS, "states-10m.json")
    with open(topo_path, "w") as f:
        f.write(topo)
    print(f"wrote {topo_path} ({len(out_features)} features)")


if __name__ == "__main__":
    build_counties()
    build_states()
