/** Synthetic credentials used only to prove structural withholding. */
export const configurationPrivateValue = "UNMARKED_CONFIG_PRIVATE_7319";
export const configurationView = {
  apiVersion: "v1",
  kind: "Config",
  contexts: [
    {
      name: "alpha",
      context: { cluster: "alpha", namespace: "app", user: configurationPrivateValue },
    },
    { name: "outside-selection", context: { cluster: "other" } },
  ],
  clusters: [
    {
      name: "alpha",
      cluster: {
        server: `https://user:${configurationPrivateValue}@api.example:6443/private?key=${configurationPrivateValue}`,
        "certificate-authority": `/private/${configurationPrivateValue}`,
        "certificate-authority-data": configurationPrivateValue,
        "proxy-url": configurationPrivateValue,
        extensions: [configurationPrivateValue],
      },
    },
  ],
  users: [
    {
      name: configurationPrivateValue,
      user: {
        token: configurationPrivateValue,
        "client-key-data": configurationPrivateValue,
        exec: { command: configurationPrivateValue, args: [configurationPrivateValue] },
        "auth-provider": { config: { value: configurationPrivateValue } },
      },
    },
  ],
  "current-context": "outside-selection",
  extensions: [configurationPrivateValue],
};
