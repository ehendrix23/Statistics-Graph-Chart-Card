/*
 * Statistics Graph Chart Card - VictoriaMetrics extension
 *
 * This file is part of the GPLv3 v4.02-based fork of Statistics Graph Chart Card.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The upstream v4.02 distribution bundle is intentionally left untouched. This
 * wrapper loads it, adds an explicit `victoriametrics` data source, and adapts
 * VictoriaMetrics range-query results to Home Assistant's existing History API
 * response shapes. The original card therefore continues to own all rendering,
 * grouping, comparison, export, offset, and chart transformations.
 */

import "./statistics-graph-chart-card.js";

const CARD_TAG = "statistics-graph-chart-card";
const VM_DATA_SOURCE = "victoriametrics";
const DEFAULT_QUERY_PATH = "/prometheus/api/v1/query_range";
const DEFAULT_STEP = "15m";
const DEFAULT_TIMEOUT_MS = 30000;
const INGRESS_VALIDATE_INTERVAL_MS = 60000;

const vmConfigByCard = new WeakMap();

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeBaseUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("victoriametrics.url must be a non-empty string");
  }
  return url.trim().replace(/\/$/, "");
}

function normalizeQueryPath(path) {
  const value =
    typeof path === "string" && path.trim() ? path.trim() : DEFAULT_QUERY_PATH;
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeAddonSlug(slug) {
  if (typeof slug !== "string" || !slug.trim()) {
    return null;
  }
  return slug.trim();
}

function resolveVmConfig(config) {
  const globalConfig = isObject(config?.victoriametrics)
    ? config.victoriametrics
    : {};
  const entities = Array.isArray(config?.entities) ? config.entities : [];
  const vmEntities = new Map();

  for (const entityConfig of entities) {
    if (!isObject(entityConfig) || entityConfig.data_source !== VM_DATA_SOURCE) {
      continue;
    }

    const entityId = entityConfig.entity;
    if (typeof entityId !== "string" || !entityId) {
      throw new Error("VictoriaMetrics entities require an entity id");
    }

    const localConfig = isObject(entityConfig.victoriametrics)
      ? entityConfig.victoriametrics
      : {};
    const query = localConfig.query;
    if (typeof query !== "string" || !query.trim()) {
      throw new Error(
        `${entityId}: data_source victoriametrics requires victoriametrics.query`,
      );
    }

    vmEntities.set(entityId, {
      query: query.trim(),
      step: localConfig.step ?? globalConfig.step ?? DEFAULT_STEP,
    });
  }

  if (!vmEntities.size) {
    return null;
  }

  const timeoutMs = Number(globalConfig.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("victoriametrics.timeout_ms must be a positive number");
  }

  const addonSlug = normalizeAddonSlug(globalConfig.addon_slug);
  const directUrl =
    typeof globalConfig.url === "string" && globalConfig.url.trim()
      ? normalizeBaseUrl(globalConfig.url)
      : null;

  if (!addonSlug && !directUrl) {
    throw new Error(
      "victoriametrics requires addon_slug for Home Assistant Ingress or url for direct access",
    );
  }

  return {
    addonSlug,
    url: directUrl,
    queryPath: normalizeQueryPath(globalConfig.query_path),
    timeoutMs,
    entities: vmEntities,
    ingressUrl: null,
    ingressSession: null,
    ingressLastValidated: 0,
  };
}

function configForUpstreamCard(config) {
  if (!Array.isArray(config?.entities)) {
    return config;
  }

  return {
    ...config,
    entities: config.entities.map((entityConfig) => {
      if (
        !isObject(entityConfig) ||
        entityConfig.data_source !== VM_DATA_SOURCE
      ) {
        return entityConfig;
      }

      // Force only VictoriaMetrics-backed entities through the upstream card's
      // already-supported history pipeline. Keep entity metadata in Home Assistant.
      const { victoriametrics: _victoriametrics, ...rest } = entityConfig;
      return { ...rest, data_source: "history" };
    }),
  };
}

function setIngressCookie(session) {
  const secure = window.location.protocol === "https:" ? ";Secure" : "";
  document.cookie =
    `ingress_session=${session};path=/api/hassio_ingress/;SameSite=Strict${secure}`;
}

function supervisorErrorDetail(error) {
  return error?.message ?? error?.error?.message ?? String(error);
}

async function createIngressSession(hass, vmConfig) {
  let response;
  try {
    response = await hass.callWS({
      type: "supervisor/api",
      endpoint: "/ingress/session",
      method: "post",
    });
  } catch (error) {
    throw new Error(
      `${vmConfig.addonSlug}: unable to create Home Assistant Ingress session: ${supervisorErrorDetail(error)}`,
    );
  }

  const session = response?.session;
  if (typeof session !== "string" || !session) {
    throw new Error(
      `${vmConfig.addonSlug}: Home Assistant returned no Ingress session`,
    );
  }

  setIngressCookie(session);
  vmConfig.ingressSession = session;
  vmConfig.ingressLastValidated = Date.now();
}

async function validateIngressSession(hass, vmConfig) {
  if (!vmConfig.ingressSession) {
    await createIngressSession(hass, vmConfig);
    return;
  }

  if (
    Date.now() - vmConfig.ingressLastValidated <
    INGRESS_VALIDATE_INTERVAL_MS
  ) {
    return;
  }

  try {
    await hass.callWS({
      type: "supervisor/api",
      endpoint: "/ingress/validate_session",
      method: "post",
      data: { session: vmConfig.ingressSession },
    });
    vmConfig.ingressLastValidated = Date.now();
  } catch (_error) {
    await createIngressSession(hass, vmConfig);
  }
}

async function resolveIngressUrl(hass, vmConfig) {
  if (vmConfig.ingressUrl) {
    return vmConfig.ingressUrl;
  }

  let addon;
  try {
    addon = await hass.callWS({
      type: "supervisor/api",
      endpoint: `/addons/${vmConfig.addonSlug}/info`,
      method: "get",
    });
  } catch (error) {
    throw new Error(
      `${vmConfig.addonSlug}: unable to read Home Assistant add-on information: ${supervisorErrorDetail(error)}`,
    );
  }

  if (!addon?.version) {
    throw new Error(`${vmConfig.addonSlug}: Home Assistant add-on is not installed`);
  }
  if (addon.state !== "started") {
    throw new Error(
      `${vmConfig.addonSlug}: Home Assistant add-on must be started (current state: ${addon.state ?? "unknown"})`,
    );
  }
  if (!addon.ingress || typeof addon.ingress_url !== "string" || !addon.ingress_url) {
    throw new Error(
      `${vmConfig.addonSlug}: Home Assistant add-on does not expose an Ingress URL`,
    );
  }

  vmConfig.ingressUrl = normalizeBaseUrl(addon.ingress_url);
  return vmConfig.ingressUrl;
}

async function resolveVmBaseUrl(hass, vmConfig, forceNewIngressSession = false) {
  if (!vmConfig.addonSlug) {
    return vmConfig.url;
  }

  if (forceNewIngressSession) {
    await createIngressSession(hass, vmConfig);
  } else {
    await validateIngressSession(hass, vmConfig);
  }

  return resolveIngressUrl(hass, vmConfig);
}

function makeRangeUrl(baseUrl, vmConfig, entityConfig, startTime, endTime) {
  const endpoint = `${baseUrl}${vmConfig.queryPath}`;
  const url = new URL(endpoint, window.location.href);
  url.searchParams.set("query", entityConfig.query);
  url.searchParams.set("start", String(startTime.getTime() / 1000));
  url.searchParams.set("end", String(endTime.getTime() / 1000));
  url.searchParams.set("step", String(entityConfig.step));
  return url;
}

async function fetchVmRange(url, timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
  }
}

async function queryVictoriaMetrics(
  hass,
  vmConfig,
  entityId,
  startTime,
  endTime,
) {
  const entityConfig = vmConfig.entities.get(entityId);
  if (!entityConfig) {
    return [];
  }

  let response;
  let url;

  try {
    const baseUrl = await resolveVmBaseUrl(hass, vmConfig);
    url = makeRangeUrl(baseUrl, vmConfig, entityConfig, startTime, endTime);
    response = await fetchVmRange(url, vmConfig.timeoutMs);

    // Ingress sessions can expire while a dashboard remains open. Recreate the
    // session once and retry the exact request before surfacing an error.
    if (
      vmConfig.addonSlug &&
      (response.status === 401 || response.status === 403)
    ) {
      const refreshedBaseUrl = await resolveVmBaseUrl(hass, vmConfig, true);
      url = makeRangeUrl(
        refreshedBaseUrl,
        vmConfig,
        entityConfig,
        startTime,
        endTime,
      );
      response = await fetchVmRange(url, vmConfig.timeoutMs);
    }
  } catch (error) {
    const detail =
      error?.name === "AbortError"
        ? `request timed out after ${vmConfig.timeoutMs} ms`
        : error?.message ?? String(error);
    throw new Error(`${entityId}: VictoriaMetrics request failed: ${detail}`);
  }

  if (!response.ok) {
    throw new Error(
      `${entityId}: VictoriaMetrics returned HTTP ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();
  if (payload?.status !== "success") {
    const detail =
      payload?.error ?? payload?.errorType ?? "unknown VictoriaMetrics error";
    throw new Error(`${entityId}: VictoriaMetrics query failed: ${detail}`);
  }

  if (payload?.data?.resultType !== "matrix") {
    throw new Error(
      `${entityId}: expected VictoriaMetrics query_range resultType matrix, got ${payload?.data?.resultType ?? "missing"}`,
    );
  }

  const series = Array.isArray(payload.data.result) ? payload.data.result : [];
  if (!series.length) {
    return [];
  }
  if (series.length !== 1) {
    throw new Error(
      `${entityId}: VictoriaMetrics query matched ${series.length} series; make victoriametrics.query select exactly one series`,
    );
  }

  const values = Array.isArray(series[0].values) ? series[0].values : [];
  return values
    .map(([timestamp, value]) => [Number(timestamp), Number(value)])
    .filter(
      ([timestamp, value]) =>
        Number.isFinite(timestamp) && Number.isFinite(value),
    )
    .sort((a, b) => a[0] - b[0]);
}

function vmSamplesToWsHistory(samples) {
  return samples.map(([timestamp, value]) => ({
    s: String(value),
    lu: timestamp,
    lc: timestamp,
    a: {},
  }));
}

function vmSamplesToRestHistory(entityId, samples) {
  return samples.map(([timestamp, value]) => {
    const iso = new Date(timestamp * 1000).toISOString();
    return {
      entity_id: entityId,
      state: String(value),
      last_changed: iso,
      last_updated: iso,
      attributes: {},
    };
  });
}

async function queryVmEntities(
  hass,
  vmConfig,
  entityIds,
  startTime,
  endTime,
  converter,
) {
  const entries = await Promise.all(
    entityIds.map(async (entityId) => [
      entityId,
      converter(
        entityId,
        await queryVictoriaMetrics(
          hass,
          vmConfig,
          entityId,
          startTime,
          endTime,
        ),
      ),
    ]),
  );
  return Object.fromEntries(entries);
}

function parseDate(value, fallback) {
  if (!value) {
    return fallback;
  }
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new Error(`Invalid history timestamp: ${value}`);
  }
  return result;
}

function splitEntityIds(entityIds, vmConfig) {
  const ids = Array.isArray(entityIds) ? entityIds : [];
  return {
    vm: ids.filter((entityId) => vmConfig.entities.has(entityId)),
    native: ids.filter((entityId) => !vmConfig.entities.has(entityId)),
  };
}

async function interceptCallWs(hass, vmConfig, message) {
  if (
    message?.type !== "history/history_during_period" ||
    !Array.isArray(message.entity_ids)
  ) {
    return hass.callWS(message);
  }

  const ids = splitEntityIds(message.entity_ids, vmConfig);
  if (!ids.vm.length) {
    return hass.callWS(message);
  }

  const now = new Date();
  const startTime = parseDate(
    message.start_time,
    new Date(now.getTime() - 86400000),
  );
  const endTime = parseDate(message.end_time, now);

  const [nativeHistory, vmHistory] = await Promise.all([
    ids.native.length
      ? hass.callWS({ ...message, entity_ids: ids.native })
      : Promise.resolve({}),
    queryVmEntities(
      hass,
      vmConfig,
      ids.vm,
      startTime,
      endTime,
      (_entityId, samples) => vmSamplesToWsHistory(samples),
    ),
  ]);

  return { ...nativeHistory, ...vmHistory };
}

function parseRestHistoryPath(path) {
  if (typeof path !== "string") {
    return null;
  }

  const url = new URL(path, `${window.location.origin}/api/`);
  const marker = "/api/history/period";
  const index = url.pathname.indexOf(marker);
  if (index < 0) {
    return null;
  }

  const suffix = url.pathname
    .slice(index + marker.length)
    .replace(/^\//, "");
  const entityIds = (url.searchParams.get("filter_entity_id") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    entityIds,
    startTime: parseDate(
      suffix ? decodeURIComponent(suffix) : null,
      new Date(Date.now() - 86400000),
    ),
    endTime: parseDate(url.searchParams.get("end_time"), new Date()),
  };
}

async function interceptCallApi(hass, vmConfig, method, path, ...args) {
  if (String(method).toLowerCase() !== "get") {
    return hass.callApi(method, path, ...args);
  }

  const request = parseRestHistoryPath(path);
  if (!request || !request.entityIds.length) {
    return hass.callApi(method, path, ...args);
  }

  const ids = splitEntityIds(request.entityIds, vmConfig);
  if (!ids.vm.length) {
    return hass.callApi(method, path, ...args);
  }

  let nativeHistory = [];
  if (ids.native.length) {
    const url = new URL(path, `${window.location.origin}/api/`);
    url.searchParams.set("filter_entity_id", ids.native.join(","));
    const apiPath = `${url.pathname.replace(/^\/api\//, "")}${url.search}`;
    nativeHistory = await hass.callApi(method, apiPath, ...args);
  }

  const vmHistoryByEntity = await queryVmEntities(
    hass,
    vmConfig,
    ids.vm,
    request.startTime,
    request.endTime,
    (entityId, samples) => vmSamplesToRestHistory(entityId, samples),
  );

  const nativeByEntity = new Map(
    (Array.isArray(nativeHistory) ? nativeHistory : [])
      .filter((states) => Array.isArray(states) && states.length)
      .map((states) => [states[0].entity_id, states]),
  );

  // Home Assistant REST history is an array of per-entity arrays. Preserve the
  // request order so the upstream card sees the same shape as its normal API.
  return request.entityIds.map(
    (entityId) =>
      vmHistoryByEntity[entityId] ?? nativeByEntity.get(entityId) ?? [],
  );
}

function findPropertyDescriptor(object, property) {
  let current = object;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor) {
      return descriptor;
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function wrapHass(card, hass) {
  const vmConfig = vmConfigByCard.get(card);
  if (!vmConfig || !hass) {
    return hass;
  }

  const wrapped = Object.create(hass);
  if (typeof hass.callWS === "function") {
    wrapped.callWS = (message) => interceptCallWs(hass, vmConfig, message);
  }
  if (typeof hass.callApi === "function") {
    wrapped.callApi = (method, path, ...args) =>
      interceptCallApi(hass, vmConfig, method, path, ...args);
  }
  return wrapped;
}

const CardClass = await customElements.whenDefined(CARD_TAG);
const originalSetConfig = CardClass.prototype.setConfig;
if (typeof originalSetConfig !== "function") {
  throw new Error(`${CARD_TAG}: unable to find setConfig()`);
}

CardClass.prototype.setConfig = function setConfigWithVictoriaMetrics(config) {
  const vmConfig = resolveVmConfig(config);
  if (vmConfig) {
    vmConfigByCard.set(this, vmConfig);
  } else {
    vmConfigByCard.delete(this);
  }
  return originalSetConfig.call(this, configForUpstreamCard(config));
};

const hassDescriptor = findPropertyDescriptor(CardClass.prototype, "hass");
if (!hassDescriptor?.set) {
  throw new Error(`${CARD_TAG}: unable to find hass setter`);
}

Object.defineProperty(CardClass.prototype, "hass", {
  configurable: true,
  enumerable: hassDescriptor.enumerable ?? false,
  get: hassDescriptor.get
    ? function getHass() {
        return hassDescriptor.get.call(this);
      }
    : undefined,
  set: function setHassWithVictoriaMetrics(hass) {
    return hassDescriptor.set.call(this, wrapHass(this, hass));
  },
});
