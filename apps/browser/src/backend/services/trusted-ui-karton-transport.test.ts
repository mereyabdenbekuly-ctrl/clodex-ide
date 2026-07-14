import type {
  IpcMain,
  IpcMainEvent,
  MessagePortMain,
  WebContents,
  WebFrameMain,
} from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { TRUSTED_UI_KARTON_CONNECT_CHANNEL } from '@shared/trusted-ui-karton';
import {
  TRUSTED_UI_REVIEWER_CONNECTION_ID,
  TrustedUiKartonTransportAdmission,
  createTrustedUiLocation,
  evaluateTrustedUiKartonConnect,
  parseGenericKartonConnectionKind,
  type TrustedUiKartonTransportAdmissionOptions,
} from './trusted-ui-karton-transport';

class FakePort {
  public closed = false;

  public close(): void {
    this.closed = true;
  }

  public asElectronPort(): MessagePortMain {
    return this as unknown as MessagePortMain;
  }
}

class FakeFrame {
  public detached = false;
  public destroyed = false;
  public parent: FakeFrame | null = null;

  public constructor(
    public frameTreeNodeId: number,
    public processId: number,
    public routingId: number,
    public frameToken: string,
    public url: string,
    public origin: string,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public asElectronFrame(): WebFrameMain {
    return this as unknown as WebFrameMain;
  }
}

class FakeWebContents {
  public destroyed = false;

  public constructor(
    public id: number,
    public mainFrame: WebFrameMain,
    private url: string,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public getURL(): string {
    return this.url;
  }

  public asElectronWebContents(): WebContents {
    return this as unknown as WebContents;
  }
}

const ALLOWED_URL = 'https://ui.clodex.test/index.html';
const ALLOWED_LOCATION = createTrustedUiLocation(ALLOWED_URL);

function createFixture(
  options: {
    actualUrl?: string;
    actualOrigin?: string;
    ports?: FakePort[];
  } = {},
) {
  const actualUrl = options.actualUrl ?? ALLOWED_LOCATION.url;
  const actualOrigin = options.actualOrigin ?? ALLOWED_LOCATION.origin;
  const frame = new FakeFrame(
    41,
    101,
    7,
    'frame-token-current',
    actualUrl,
    actualOrigin,
  );
  const webContents = new FakeWebContents(
    11,
    frame.asElectronFrame(),
    actualUrl,
  );
  const ports = options.ports ?? [new FakePort()];
  const event = {
    sender: webContents.asElectronWebContents(),
    senderFrame: frame.asElectronFrame(),
    processId: frame.processId,
    frameId: frame.routingId,
    ports: ports.map((port) => port.asElectronPort()),
  } as unknown as IpcMainEvent;
  return { frame, webContents, ports, event };
}

function createAdmission(
  fixture: ReturnType<typeof createFixture>,
  overrides: Partial<TrustedUiKartonTransportAdmissionOptions> = {},
) {
  const { acceptPort: overrideAcceptPort, ...otherOverrides } = overrides;
  let listener: ((event: IpcMainEvent, ...args: unknown[]) => void) | undefined;
  const ipc = {
    on: vi.fn(
      (
        channel: string,
        next: (event: IpcMainEvent, ...args: unknown[]) => void,
      ) => {
        expect(channel).toBe(TRUSTED_UI_KARTON_CONNECT_CHANNEL);
        listener = next;
      },
    ),
    off: vi.fn(),
  } as unknown as Pick<IpcMain, 'on' | 'off'>;
  const acceptPort = vi.fn(
    overrideAcceptPort ?? (() => TRUSTED_UI_REVIEWER_CONNECTION_ID),
  );
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const admission = new TrustedUiKartonTransportAdmission({
    ipc,
    getCurrentUiWebContents: () => fixture.webContents.asElectronWebContents(),
    getAllowedUiLocation: () => ALLOWED_LOCATION,
    acceptPort,
    logger,
    ...otherOverrides,
  }).start();
  return { admission, ipc, acceptPort, logger, getListener: () => listener };
}

describe('trusted UI Karton boundary', () => {
  it('uses Electron file:// origin while preserving the exact packaged URL', () => {
    const location = createTrustedUiLocation(
      'file:///Applications/CLODEx%20IDE/renderer/main_window/index.html',
    );

    expect(location).toEqual({
      url: 'file:///Applications/CLODEx%20IDE/renderer/main_window/index.html',
      origin: 'file://',
    });
  });

  it('keeps trusted reviewer identity out of generic renderer-selected roles', () => {
    expect(parseGenericKartonConnectionKind('tab')).toBe('tab');
    expect(parseGenericKartonConnectionKind('pages-api')).toBe('pages-api');

    for (const untrusted of [
      TRUSTED_UI_REVIEWER_CONNECTION_ID,
      'ui',
      'pages',
      'reviewer',
      '',
      undefined,
    ]) {
      expect(parseGenericKartonConnectionKind(untrusted)).toBeNull();
    }
  });

  it('accepts one null-marker port from the current UI main frame', () => {
    const fixture = createFixture();
    const decision = evaluateTrustedUiKartonConnect(
      fixture.event,
      [null],
      fixture.webContents.asElectronWebContents(),
      ALLOWED_LOCATION,
    );

    expect(decision).toEqual({
      ok: true,
      port: fixture.ports[0]?.asElectronPort(),
    });
  });

  it('registers the dedicated channel and injects ui-main internally', () => {
    const fixture = createFixture();
    const { admission, ipc, acceptPort, getListener } =
      createAdmission(fixture);

    getListener()?.(fixture.event, null);

    expect(acceptPort).toHaveBeenCalledOnce();
    expect(acceptPort).toHaveBeenCalledWith(fixture.ports[0]?.asElectronPort());
    expect(fixture.ports[0]?.closed).toBe(false);

    admission.teardown();
    expect(ipc.off).toHaveBeenCalledWith(
      TRUSTED_UI_KARTON_CONNECT_CHANNEL,
      getListener(),
    );
  });

  it('rejects renderer-supplied role or connection identity payloads', () => {
    for (const marker of ['ui-main', 'ui', 'pages', {}, undefined]) {
      const fixture = createFixture();
      const { admission, acceptPort } = createAdmission(fixture);

      expect(admission.handleConnect(fixture.event, [marker])).toBe(false);
      expect(acceptPort).not.toHaveBeenCalled();
      expect(fixture.ports[0]?.closed).toBe(true);
      admission.teardown();
    }
  });

  it('requires exactly one transferred port and closes every extra port', () => {
    for (const ports of [[], [new FakePort(), new FakePort()]]) {
      const fixture = createFixture({ ports });
      const { admission, acceptPort } = createAdmission(fixture);

      expect(admission.handleConnect(fixture.event, [null])).toBe(false);
      expect(acceptPort).not.toHaveBeenCalled();
      expect(ports.every((port) => port.closed)).toBe(true);
      admission.teardown();
    }
  });

  it('rejects browser/pages renderers and a stale recreated UI', () => {
    const fixture = createFixture();
    const foreign = createFixture();
    const replacement = createFixture();

    expect(
      evaluateTrustedUiKartonConnect(
        foreign.event,
        [null],
        fixture.webContents.asElectronWebContents(),
        ALLOWED_LOCATION,
      ),
    ).toEqual({ ok: false, reason: 'stale-or-foreign-web-contents' });
    expect(
      evaluateTrustedUiKartonConnect(
        fixture.event,
        [null],
        replacement.webContents.asElectronWebContents(),
        ALLOWED_LOCATION,
      ),
    ).toEqual({ ok: false, reason: 'stale-or-foreign-web-contents' });
  });

  it('closes ports for foreign, stale, or missing current UI admission', () => {
    for (const getCurrentUiWebContents of [
      () => createFixture().webContents.asElectronWebContents(),
      () => null,
    ]) {
      const fixture = createFixture();
      const { admission, acceptPort } = createAdmission(fixture, {
        getCurrentUiWebContents,
      });

      expect(admission.handleConnect(fixture.event, [null])).toBe(false);
      expect(acceptPort).not.toHaveBeenCalled();
      expect(fixture.ports[0]?.closed).toBe(true);
      admission.teardown();
    }
  });

  it('rejects subframes even when they belong to the current UI WebContents', () => {
    const fixture = createFixture();
    const child = new FakeFrame(
      42,
      fixture.frame.processId,
      8,
      'child-token',
      ALLOWED_LOCATION.url,
      ALLOWED_LOCATION.origin,
    );
    child.parent = fixture.frame;
    const event = {
      ...fixture.event,
      senderFrame: child.asElectronFrame(),
      frameId: child.routingId,
    } as IpcMainEvent;

    expect(
      evaluateTrustedUiKartonConnect(
        event,
        [null],
        fixture.webContents.asElectronWebContents(),
        ALLOWED_LOCATION,
      ),
    ).toEqual({ ok: false, reason: 'subframe-or-stale-frame' });
  });

  it('closes a subframe port without admitting it', () => {
    const fixture = createFixture();
    const child = new FakeFrame(
      42,
      fixture.frame.processId,
      8,
      'child-token',
      ALLOWED_LOCATION.url,
      ALLOWED_LOCATION.origin,
    );
    child.parent = fixture.frame;
    const event = {
      ...fixture.event,
      senderFrame: child.asElectronFrame(),
      frameId: child.routingId,
    } as IpcMainEvent;
    const { admission, acceptPort } = createAdmission(fixture);

    expect(admission.handleConnect(event, [null])).toBe(false);
    expect(acceptPort).not.toHaveBeenCalled();
    expect(fixture.ports[0]?.closed).toBe(true);
    admission.teardown();
  });

  it('rejects a wrong pre-authorized URL or origin', () => {
    for (const fixture of [
      createFixture({ actualUrl: 'https://attacker.test/index.html' }),
      createFixture({ actualOrigin: 'https://attacker.test' }),
    ]) {
      expect(
        evaluateTrustedUiKartonConnect(
          fixture.event,
          [null],
          fixture.webContents.asElectronWebContents(),
          ALLOWED_LOCATION,
        ),
      ).toEqual({ ok: false, reason: 'wrong-ui-location' });
    }
  });

  it('closes a wrong-location port without admitting it', () => {
    const fixture = createFixture({
      actualUrl: 'https://attacker.test/index.html',
      actualOrigin: 'https://attacker.test',
    });
    const { admission, acceptPort } = createAdmission(fixture);

    expect(admission.handleConnect(fixture.event, [null])).toBe(false);
    expect(acceptPort).not.toHaveBeenCalled();
    expect(fixture.ports[0]?.closed).toBe(true);
    admission.teardown();
  });

  it('rejects a different packaged file even when file:// origin matches', () => {
    const allowed = createTrustedUiLocation(
      'file:///opt/clodex/renderer/main_window/index.html',
    );
    const fixture = createFixture({
      actualUrl: 'file:///opt/clodex/renderer/pages/index.html',
      actualOrigin: 'file://',
    });

    expect(
      evaluateTrustedUiKartonConnect(
        fixture.event,
        [null],
        fixture.webContents.asElectronWebContents(),
        allowed,
      ),
    ).toEqual({ ok: false, reason: 'wrong-ui-location' });
  });

  it('closes the port if trusted backend injection returns any ID but ui-main', () => {
    const fixture = createFixture();
    const { admission, acceptPort } = createAdmission(fixture, {
      acceptPort: () => 'ui',
    });

    expect(admission.handleConnect(fixture.event, [null])).toBe(false);
    expect(acceptPort).toHaveBeenCalledOnce();
    expect(fixture.ports[0]?.closed).toBe(true);
    admission.teardown();
  });

  it('fails closed after teardown', () => {
    const fixture = createFixture();
    const { admission, acceptPort } = createAdmission(fixture);
    admission.teardown();

    expect(admission.handleConnect(fixture.event, [null])).toBe(false);
    expect(acceptPort).not.toHaveBeenCalled();
    expect(fixture.ports[0]?.closed).toBe(true);
  });
});
