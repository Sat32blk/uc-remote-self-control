// Pages of the integration's setup flow (web configurator → integration → Configure) that don't
// depend on the driver's state.

export const PIN_PAGE = [
  {
    id: "pin",
    label: { en: "Web-configurator PIN" },
    field: { text: { value: "" } }
  },
  {
    id: "address",
    label: { en: "Remote address (leave as 127.0.0.1 unless setup fails)" },
    field: { text: { value: "127.0.0.1" } }
  }
];

export function rulesPage(text, errors, builderUrl = "") {
  const page = [];
  if (errors && errors.length) {
    page.push({
      id: "errors",
      label: { en: "Not saved: please fix" },
      field: { label: { value: { en: errors.slice(0, 8).map((e) => "- " + e).join("\n") } } }
    });
  }
  page.push({
    id: "help",
    label: { en: "Smart Controls" },
    field: {
      label: {
        value: {
          en: "The builder page is easier: " + builderUrl + " . You can also paste or edit the rules here. Each control becomes an entity in the **Remote Smart Controls** group. After saving, add any new controls to the integration and to the activities that use them."
        }
      }
    }
  });
  page.push({ id: "rules", label: { en: "Rules (JSON)" }, field: { textarea: { value: text } } });
  return page;
}

export function prettyRules(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
