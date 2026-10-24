// The desktop app's private parent port for the launcher's desktop mode (OMB_TEST_DESKTOP_OWNER_TOKEN, with
// OMB_DESKTOP_PARENT=1): the server runs as Electron's utility process, and only the test's owner capability crosses.
// OMB_TEST_DESKTOP_PAGES_ACCESS: the published pages' access the app hands over for a signed-in MausBot account, as JSON.
const token = process.env.OMB_TEST_DESKTOP_OWNER_TOKEN;
const pages = process.env.OMB_TEST_DESKTOP_PAGES_ACCESS;
delete process.env.OMB_TEST_DESKTOP_OWNER_TOKEN;
delete process.env.OMB_TEST_DESKTOP_PAGES_ACCESS;
if (token) {
  Object.defineProperty(process, "parentPort", {
    value: {
      on(event, listener) {
        if (event !== "message") return;
        queueMicrotask(() => listener({ data: { type: "openmausbot:desktop-mutation-token", token } }));
        if (pages) queueMicrotask(() => listener({ data: { type: "openmausbot:included-pages", access: JSON.parse(pages) } }));
      },
      postMessage() {},
    },
  });
}
