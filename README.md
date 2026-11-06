# Spectrum Sync Server - retired

Retired on 7 Nov 2026. Every request now gets `410 Gone`; the process reads no
mail, report or SMTP setting. The platform runs on Firestore and the
`korevra-relay` Cloud Run service. The earlier code is in git history
(6f3fd3e and before).

To finish: suspend or delete the Render service, remove its `SMTP_*`
environment variables, and revoke the Gmail app password it used.
