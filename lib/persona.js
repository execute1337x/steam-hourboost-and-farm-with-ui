const PERSONA_OPTIONS = [
  { value: 1, label: "Çevrimiçi" },
  { value: 3, label: "Uzakta" },
  { value: 7, label: "Görünmez" },
  { value: 0, label: "Çevrimdışı" },
];

const ALLOWED_PERSONA = new Set(PERSONA_OPTIONS.map((o) => o.value));

const DEFAULT_PERSONA = 1;

function normalizePersona(value) {
  if (value === "" || value === null || value === undefined) {
    return DEFAULT_PERSONA;
  }
  const parsed = parseInt(value, 10);
  if (!ALLOWED_PERSONA.has(parsed)) {
    return DEFAULT_PERSONA;
  }
  return parsed;
}

function getPersonaLabel(value) {
  const normalized = normalizePersona(value);
  return PERSONA_OPTIONS.find((o) => o.value === normalized)?.label || "Çevrimiçi";
}

module.exports = {
  PERSONA_OPTIONS,
  ALLOWED_PERSONA,
  DEFAULT_PERSONA,
  normalizePersona,
  getPersonaLabel,
};
