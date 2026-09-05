# VictoriaMetrics data source

This fork adds an explicit `victoriametrics` history data source to the GPLv3 v4.02 Statistics Graph Chart Card.

## Design

The upstream v4.02 distribution bundle is intentionally left unchanged. `statistics-graph-chart-card-vm.js` loads the original card and adapts VictoriaMetrics range-query results into the same Home Assistant History API shapes that the card already consumes.

That means Home Assistant remains authoritative for the entity itself (entity ID, friendly name, unit, icon, device/state metadata, and current state), while VictoriaMetrics supplies historical numeric samples only.

Existing `data_source` behavior is preserved:

- `auto` — unchanged
- `statistics` — unchanged
- `history` — unchanged
- `victoriametrics` — new and explicitly opt-in per entity

There is deliberately no automatic HA-to-VictoriaMetrics range switching in this first implementation.

## Configuration

Configure the VictoriaMetrics endpoint at card level and opt individual entities into it:

```yaml
type: custom:statistics-graph-chart-card
victoriametrics:
  url: /victoriametrics
  step: 15m
  # Optional; defaults shown below:
  # query_path: /prometheus/api/v1/query_range
  # timeout_ms: 30000
entities:
  - entity: sensor.outside_temperature
    data_source: victoriametrics
    victoriametrics:
      query: 'ha_outside_temperature_15m_avg{entity_id="sensor.outside_temperature"}'

  - entity: sensor.indoor_temperature
    data_source: history
```

`victoriametrics.query` is required for every entity using the VictoriaMetrics data source. The query must resolve to exactly one time series. This is intentional: metric naming and labels are installation-specific, so the card must not guess how a Home Assistant entity maps to a VictoriaMetrics series.

### Per-entity step

The card-level `step` defaults to `15m`, matching the planned 15-minute retained aggregation tier. It can be overridden per entity:

```yaml
entities:
  - entity: sensor.energy_import
    data_source: victoriametrics
    victoriametrics:
      query: 'ha_energy_import_1h_increase{entity_id="sensor.energy_import"}'
      step: 1h
```

Use a step appropriate for the stored series. For example, use `15m` for 15-minute stream-aggregated series and `1h` for the separate hourly tier.

## VictoriaMetrics API

The wrapper uses VictoriaMetrics' Prometheus-compatible range endpoint:

```text
/prometheus/api/v1/query_range
```

It sends:

- `query`
- `start`
- `end`
- `step`

The response must be a successful `matrix` result. A query returning more than one series is rejected rather than silently combining series.

## Browser/network requirement

The card runs in the Home Assistant browser, so the VictoriaMetrics endpoint must be reachable from the browser running the dashboard.

The recommended production layout is a same-origin reverse proxy, for example:

```yaml
victoriametrics:
  url: /victoriametrics
```

This avoids browser CORS restrictions and HTTPS-to-HTTP mixed-content blocking. A direct cross-origin VictoriaMetrics URL can work only when the server/network path and CORS policy explicitly allow the Home Assistant frontend origin.

Do not place VictoriaMetrics credentials or secrets in Lovelace YAML. Dashboard configuration is delivered to the browser. Authentication, if required, should be handled by a trusted reverse proxy or another server-side mechanism.

## Data adaptation

For WebSocket history requests (`history/history_during_period`), VictoriaMetrics samples are converted to Home Assistant's compact history state shape:

```text
{ s, lu, lc, a }
```

For the legacy REST History API, samples are converted to normal Home Assistant state-history objects.

If a request contains both native Home Assistant history entities and VictoriaMetrics-backed entities, the wrapper queries both sources and merges the result in the format expected by the original card.

The original card still performs all downstream chart logic, including grouping, offsets/comparisons, date ranges, zoom, visualization, and export.

## Current scope

This first implementation intentionally does not add:

- automatic recent-history HA / older-history VictoriaMetrics switching;
- automatic Home Assistant entity-to-MetricsQL mapping;
- combining multiple VictoriaMetrics series into one entity;
- a visual-editor control for VictoriaMetrics configuration;
- VictoriaMetrics authentication secrets in card configuration;
- any Home Assistant or VictoriaMetrics deployment changes.

Those can be added after this explicit provider path has been exercised against the real Home Assistant + VictoriaMetrics environment.

## Validation performed before commit

The wrapper was syntax-checked with Node.js and exercised against mocks covering:

1. translation of only `data_source: victoriametrics` entities into the upstream `history` pipeline;
2. construction of `/prometheus/api/v1/query_range` requests;
3. merging native HA history with VictoriaMetrics data through `history/history_during_period`;
4. legacy REST History API compatibility;
5. pass-through of unrelated Home Assistant WebSocket traffic.

Live Home Assistant/VictoriaMetrics validation is intentionally deferred until the planned Proxmox migration is complete.
