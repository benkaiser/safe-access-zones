import { readFile } from "node:fs/promises";

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function makeAdditionService(addition) {
  return {
    id: addition.id,
    name: addition.name,
    service_type: "Pregnancy termination",
    suburb: addition.suburb,
    state: addition.state.toUpperCase(),
    postcode: "",
    latitude: addition.latitude,
    longitude: addition.longitude,
    appointment_required: false,
    is_virtual: false,
    record_origin: "manual",
  };
}

export async function readServiceSources(root) {
  const healthdirect = await readJson(
    new URL("pregnancy_termination_services.json", root),
    [],
  );
  const supplemental = await readJson(
    new URL("data/supplemental-locations.json", root),
    [],
  );
  if (!Array.isArray(healthdirect)) {
    throw new Error("pregnancy_termination_services.json must contain an array");
  }
  if (!Array.isArray(supplemental)) {
    throw new Error("data/supplemental-locations.json must contain an array");
  }
  return {
    healthdirect: healthdirect.map((service) => ({
      ...service,
      record_origin: "healthdirect",
    })),
    supplemental: supplemental.map((service) => ({
      ...service,
      record_origin: "supplemental",
    })),
  };
}
