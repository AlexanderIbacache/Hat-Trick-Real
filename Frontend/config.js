// Public frontend settings only. Runtime credentials are requested from the
// local backend so no key is committed with the frontend source.
window.APP_CONFIG = {
  BACKEND_URL: "http://localhost:3001",
  DEFAULT_VIEW: {
    lat: 37.2296,
    lng: -80.4139,
    altitude: 1400,
    range: 3000,
    tilt: 70,
    heading: 20,
  },
};
