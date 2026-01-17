# Lightcast 2024 Economic Complexity Analysis

**Generated:** 2026-01-16 19:33:24.510699

## Methodology
This analysis implements the economic complexity methodology from:
"Economic Complexity and Technological Relatedness: Findings for American Cities" by Daboin et al.

## Contents

### Data Frames (Parquet)
alaska_pop - Alaska county populations (for Valdez-Cordova split)
tigris_2024_counties - TIGRIS county reference (geoid, name)
tigris_2024_states - TIGRIS state reference (fips, name)
cz - Commuting zone crosswalk (county to CZ)
county_state_cbsa_csa_cz_crosswalk - Full county-state-CBSA-CSA-CZ crosswalk
county_geometry - County boundaries (sf/geoparquet)
state_geometry - State boundaries (sf/geoparquet)
cbsa_geometry - CBSA boundaries (sf/geoparquet)
csa_geometry - CSA boundaries (sf/geoparquet)
cz_geometry - Commuting zone boundaries (sf/geoparquet)
lightcast_2024_data - Raw Lightcast data (with Alaska fix)
lightcast_with_geodata - Lightcast with all geographic levels joined
state_industry - State-industry employment and LQs
cbsa_industry - CBSA-industry employment and LQs
csa_industry - CSA-industry employment and LQs
cz_industry - Commuting zone-industry employment and LQs
county_empshare_lq - County employment shares and LQs
state_empshare_lq - State employment shares and LQs
cbsa_empshare_lq - CBSA employment shares and LQs
csa_empshare_lq - CSA employment shares and LQs
commuting_zone_empshare_lq - Commuting zone employment shares and LQs
combined_empshare_lq - All levels combined (long format)
county_names - County geoid-to-name lookup
state_names - State fips-to-name lookup
cbsa_names - CBSA geoid-to-name lookup
csa_names - CSA geoid-to-name lookup
cz_names - Commuting zone geoid-to-name lookup
industry_titles - Industry code-to-description lookup
geo_aggregation_levels - Geographic aggregation level codes
combined_diversity - Diversity (K_c0) for all levels
combined_ubiquity - Ubiquity (K_i0) for all levels
combined_eci - ECI for all levels
combined_ici - ICI for all levels
validation_results - Daboin equation validation summary

### Complexity Results
- ECI (Economic Complexity Index) for each geographic level
- ICI (Industry Complexity Index) for each geographic level
- Diversity and Ubiquity metrics
- K_c1 (Average Ubiquity) and K_i1 (Average Diversity)

### Peer Geography Analysis
- Jaccard similarity matrices based on M_ci (industry specialization)
- Top 5 peer relationships for each geography

## Geographic Levels
- County (3143)
- State (51)
- CBSA (925)
- CSA (181)
- Commuting Zone (588)

## Industries
- NAICS 6-digit codes: 947

