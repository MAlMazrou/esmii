# Monitoring dashboard visual specification

Status: `DRAFT`

The user approved the monitoring dashboard requirements and greyscale design-system direction on 2 September 2026. These generated images are implementation references for Prompt 07; they were not independently reviewed or approved as a design document:

- `desktop-production.png` — primary production overview at 1536 x 1024;
- `mobile-staging.png` — responsive staging overview at 390 CSS pixels wide;
- `operator-auth.png` — password and mandatory authenticator-code states.

The images illustrate layout rhythm, typography hierarchy, environment treatment, component anatomy, border treatment, density, and the semantic-color discipline described by Prompt 07. The approved written Prompt 07 contract remains authoritative. Values, timestamps, request identifiers, health states, and operator addresses shown in the images are illustrative dynamic content rather than fixtures or production facts.

The code-native interface must use the approved semantic token contract. It must not copy the raster images into the application, expose monitoring data before authentication, or treat image-generated sample values as defaults. A future user review may promote or supersede this visual reference without changing the monitoring contract.
