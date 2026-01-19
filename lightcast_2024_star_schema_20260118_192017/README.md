# Lightcast 2024 Economic Complexity Analysis - STAR SCHEMA

Generated: 2026-01-18 19:22:13.227691

Methodology: Daboin et al.

## Star Schema Design

This dataset uses a star schema data model for efficient querying and analysis.

### Dimension Tables
- `dim_geo_level`: Geographic aggregation levels (county, state, CBSA, CSA, CZ)
- `dim_geography`: All geographies with surrogate keys
- `dim_industry`: All industries (6-digit NAICS) with surrogate keys
- `bridge_county_hierarchy`: Maps counties to parent geographies

### Fact Tables
- `fact_geo_industry`: Main fact table - geography-industry pairs with LQ, density, strategic gain
- `fact_geography`: Geography-level aggregates (ECI, diversity, strategic index)
- `fact_industry`: Industry-level metrics by geo level (ICI, ubiquity, centrality)
- `fact_industry_proximity`: Industry space network edges (proximity weights)

### Geometry Tables
- `geo_county`, `geo_state`, `geo_cbsa`, `geo_csa`, `geo_cz`: Standardized MULTIPOLYGON boundaries

### Meta Tables
- `meta_complexity_diagnostics`: Validation metrics by geographic level

## File Formats
- **RDS**: R native format (all objects)
- **Parquet**: Efficient columnar format (non-geo)
- **CSV / CSV.gz**: Universal interchange (non-geo)
- **Geoparquet**: Efficient geo format (geo)
- **Geopackage (.gpkg)**: OGC standard geo format (geo)

## Example Queries

### Get ECI and name for all counties:
```r
fact_geography %>%
  left_join(dim_geography, by = 'geography_id') %>%
  filter(geo_level_id == 1)
```

### Get top industries by feasibility for a specific county:
```r
target_geo_id <- dim_geography %>% filter(geoid == '06037') %>% pull(geography_id)
fact_geo_industry %>%
  filter(geography_id == target_geo_id) %>%
  left_join(dim_industry, by = 'industry_id') %>%
  arrange(desc(industry_feasibility))
```

