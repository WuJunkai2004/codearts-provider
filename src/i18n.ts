// Central bilingual texts (Chinese / English).
// Pattern mirrors opencode-glm-vistatus/src/ui/i18n.ts.

export interface Translations {
  /** Name of the placeholder model shown when no credentials exist. */
  hintModelName: string;
  /** /connect built-in "API key" page title; doubles as the method label. */
  skTitle: string;
  /** /connect custom prompt message (step 1). */
  akPrompt: string;
  /** /connect custom prompt placeholder (step 1). */
  akPlaceholder: string;
}

const ZH_T: Translations = {
  hintModelName: "未连接 — 请使用 /connect 添加华为云 CodeArts AK/SK",
  skTitle: "华为云 CodeArts 密钥（SK，第 2/2 步）",
  akPrompt: "华为云 CodeArts 访问密钥（AK，第 1/2 步）",
  akPlaceholder: "Access Key Id",
};

const EN_T: Translations = {
  hintModelName: "Not connected — add Huawei CodeArts AK/SK via /connect",
  skTitle: "Huawei CodeArts Secret Key (SK, step 2/2)",
  akPrompt: "Huawei CodeArts Access Key (AK, step 1/2)",
  akPlaceholder: "Access Key Id",
};

export function getTranslations(langZH: boolean): Translations {
  return langZH ? ZH_T : EN_T;
}

// CODEARTS_LANG (test override) → LC_ALL → LANG → "en".
// zh* variants (zh-cn, zh-hans, zh-tw, zh-hant) all count as Chinese.
export function detectLangZH(): boolean {
  const raw = (
    process.env["CODEARTS_LANG"] ??
    process.env["LC_ALL"] ??
    process.env["LANG"] ??
    "en"
  ).toLowerCase();
  const lang = raw.split(/[._:]/)[0] ?? "en";
  return lang === "zh" || lang.startsWith("zh-");
}
