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


def _normalize_ring_antimeridian(ring):
    """If a ring spans the antimeridian, shift positive lons by -360 so the
    ring stays contiguous in negative-longitude space (matches us-atlas)."""
    lons = [pt[0] for pt in ring]
    if max(lons) - min(lons) <= 180:
        return ring
    return [[lon - 360 if lon > 0 else lon, lat, *rest] for lon, lat, *rest in ring]


def _normalize_geometry_antimeridian(geom):
    t = geom["type"]
    if t == "Polygon":
        geom = {**geom, "coordinates": [_normalize_ring_antimeridian(r) for r in geom["coordinates"]]}
    elif t == "MultiPolygon":
        new_polys = []
        for poly in geom["coordinates"]:
            # treat the whole polygon as one unit: if the union of its rings spans the
            # antimeridian, shift every ring whose own min_lon is positive.
            all_lons = [pt[0] for ring in poly for pt in ring]
            if all_lons and (max(all_lons) - min(all_lons)) > 180:
                new_polys.append([
                    [[lon - 360 if lon > 0 else lon, lat, *rest] for lon, lat, *rest in ring]
                    for ring in poly
                ])
            else:
                new_polys.append(poly)
        # Also handle the case where individual sub-polygons sit on opposite sides
        # of the antimeridian (the Aleutians case): if the bbox of the whole
        # MultiPolygon spans >180, shift any sub-polygon whose min_lon is positive.
        bbox_lons = [pt[0] for poly in new_polys for ring in poly for pt in ring]
        if bbox_lons and (max(bbox_lons) - min(bbox_lons)) > 180:
            shifted = []
            for poly in new_polys:
                poly_lons = [pt[0] for ring in poly for pt in ring]
                if min(poly_lons) > 0:
                    shifted.append([
                        [[lon - 360, lat, *rest] for lon, lat, *rest in ring]
                        for ring in poly
                    ])
                else:
                    shifted.append(poly)
            new_polys = shifted
        geom = {**geom, "coordinates": new_polys}
    return geom


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
                "geometry": _normalize_geometry_antimeridian(feat["geometry"]),
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
                "geometry": _normalize_geometry_antimeridian(mapping(geom_wgs)),
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
