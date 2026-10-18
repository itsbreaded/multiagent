# Jira attachment preview demo

This standalone Electron window demonstrates the attachment preview path with a bundled SVG fixture. It does not connect to Jira, read `.env`, or use Jira credentials.

The main process starts a loopback-only Jira-like attachment endpoint, requests a byte range with synthetic demo authentication, checks the response, and returns the image bytes over a narrow preload bridge. The renderer creates an in-memory Blob URL for the inline preview and full-size viewer. The attachment is never written to disk.

Run it from this folder with:

```powershell
npm start
```

The local endpoint simulates an authenticated attachment endpoint; replace it with a sandbox attachment ID and the app's main-process Jira client to test a real attachment.
