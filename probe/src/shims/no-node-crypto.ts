// libsodium's random-number code falls back to require("crypto") when the
// page has no window.crypto. This plugin must not import anything from Node,
// because the same main.js runs on phones. The build points that import here,
// so the fallback fails with libsodium's own "no secure random number
// generator" error instead of pulling in a Node module.
throw new Error("Node's crypto module is not available in this plugin");
