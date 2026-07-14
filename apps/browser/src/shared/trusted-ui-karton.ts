/**
 * Dedicated main-UI Karton admission channel.
 *
 * The preload sends only a null protocol marker plus one transferred port.
 * Reviewer role and Karton connection identity are injected by trusted
 * backend code and are never selected by a renderer payload.
 */
export const TRUSTED_UI_KARTON_CONNECT_CHANNEL = 'trusted-ui-karton-connect-v1';
