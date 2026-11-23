# Alaxee Proxy privacy notice

Last updated: 2026-11-06

Alaxee Proxy is a local-only Microsoft Edge extension that lets the user control Edge's browser proxy setting and maintain a direct-connection bypass list for selected hostnames.

## Information the extension accesses

- When the user invokes the extension on a web page, `activeTab` is used to read that tab's URL so the user can add the current hostname to the bypass list.
- The extension stores its proxy mode, proxy address and port, and domain rule lists in the browser's local extension storage (`chrome.storage.local`).
- The extension does not read page contents, form fields, passwords, or browsing history.

## Optional per-tab status icons

If the user enables the optional `tabs` permission, the extension reads tab URLs to determine whether each HTTP/HTTPS tab is sent to the configured proxy listener, bypassed by the direct list (including local addresses), or has an unknown/externally controlled state. This processing happens locally in the extension service worker and is used only to update that tab's toolbar icon and tooltip. The extension does not read page contents, form fields, passwords, browsing history, or transmit tab URLs to any server. The permission can remain ungranted; in that case the toolbar shows an unknown per-page state rather than guessing.

## Optional cross-device sync (off by default)

The extension can optionally sync its settings and domain rule lists across devices through the browser's own sync storage (`chrome.storage.sync`). **This is off unless the user turns it on**, and the setting screen states what it means before the switch is offered.

When enabled, the following leaves the device: proxy mode, protocol, address, port, the two domain rule lists, and the two display preferences. It does **not** include browsing history, page contents, tab URLs, or any record of the sites visited.

The data is stored under the user's own Microsoft account by Microsoft Edge, subject to Microsoft's terms; Alaxee Proxy operates no server and cannot read it. Turning sync off stops further uploads.

## Collection, transmission, and sharing

Alaxee Proxy does not send this information to Alaxee, a developer-operated server, analytics provider, or other third party. The only exception is the optional cross-device sync described above, which uses the browser's own sync storage under the user's account and is off by default. It does not include accounts, cloud sync, telemetry, remote configuration, or advertising. The settings and bypass list remain in the local Edge profile.

When proxy mode is enabled, Edge sends browser network requests to the endpoint configured by the user (typically a listener on `127.0.0.1`). The proxy application and its operator may process network traffic according to their own configuration and privacy practices. Alaxee Proxy does not operate that proxy service.

## User controls

Users can change or remove the proxy endpoint and domain rules in the extension, switch Edge to direct connection, turn cross-device sync off at any time, or uninstall the extension. Uninstalling the extension removes its local extension storage according to Edge's extension-data behavior.

## Changes and contact

This notice will be updated if the extension's data practices change. For support or privacy questions, use the contact details shown in the Alaxee Proxy project repository.
