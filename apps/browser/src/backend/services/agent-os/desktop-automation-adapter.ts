import { execFile } from 'node:child_process';
import {
  desktopCapturer,
  globalShortcut,
  shell,
  systemPreferences,
} from 'electron';
import type {
  DesktopAutomationApp,
  DesktopAutomationElementRole,
  DesktopAutomationPermissionKind,
  DesktopAutomationPermissions,
} from '@shared/desktop-automation';
import { DESKTOP_AUTOMATION_KILL_SWITCH_ACCELERATOR } from '@shared/desktop-automation';
import { selectUniqueDesktopCaptureSource } from './desktop-capture-source';

const OSASCRIPT_PATH = '/usr/bin/osascript';
const APPLE_SCRIPT_TIMEOUT_MS = 5_000;
const APPLE_SCRIPT_MAX_BUFFER = 256 * 1024;
const CAPTURE_MAX_WIDTH = 1_920;
const CAPTURE_MAX_HEIGHT = 1_080;
const CAPTURE_MAX_BYTES = 12 * 1024 * 1024;

const TEXT_HELPERS = `
on replaceText(findText, replacementText, sourceText)
  set previousDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to findText
  set sourceItems to text items of sourceText
  set AppleScript's text item delimiters to replacementText
  set resultText to sourceItems as text
  set AppleScript's text item delimiters to previousDelimiters
  return resultText
end replaceText

on cleanText(sourceValue)
  if sourceValue is missing value then return ""
  set resultText to sourceValue as text
  set resultText to my replaceText(tab, " ", resultText)
  set resultText to my replaceText(return, " ", resultText)
  set resultText to my replaceText(linefeed, " ", resultText)
  return resultText
end cleanText
`;

const FRONTMOST_APP_SCRIPT = `
${TEXT_HELPERS}

on run argv
  tell application "System Events"
    set frontProcess to first application process whose frontmost is true
    set appName to my cleanText(name of frontProcess)
    set bundleId to ""
    set windowTitle to ""
    try
      set bundleId to my cleanText(bundle identifier of frontProcess)
    end try
    try
      set windowTitle to my cleanText(name of front window of frontProcess)
    end try
    return appName & tab & bundleId & tab & windowTitle
  end tell
end run
`;

const INSPECT_FRONTMOST_APP_SCRIPT = `
${TEXT_HELPERS}

on isSupportedRole(roleValue)
  return roleValue is in {"AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXDisclosureTriangle"}
end isSupportedRole

on run argv
  set maximumElements to 50
  if (count of argv) > 0 then set maximumElements to item 1 of argv as integer

  tell application "System Events"
    set frontProcess to first application process whose frontmost is true
    set appName to my cleanText(name of frontProcess)
    set bundleId to ""
    set windowTitle to ""
    try
      set bundleId to my cleanText(bundle identifier of frontProcess)
    end try
    try
      set windowTitle to my cleanText(name of front window of frontProcess)
    end try

    set outputLines to {"APP" & tab & appName & tab & bundleId & tab & windowTitle}
    set emittedCount to 0
    set allElements to {}
    try
      set allElements to entire contents of front window of frontProcess
    end try

    repeat with elementIndex from 1 to count of allElements
      if emittedCount is greater than or equal to maximumElements then exit repeat
      set elementRef to item elementIndex of allElements
      try
        set roleValue to my cleanText(role of elementRef)
        if my isSupportedRole(roleValue) then
          set subroleValue to ""
          set titleValue to ""
          set descriptionValue to ""
          set enabledValue to true
          try
            set subroleValue to my cleanText(subrole of elementRef)
          end try
          try
            set titleValue to my cleanText(title of elementRef)
          end try
          try
            if titleValue is "" then set titleValue to my cleanText(name of elementRef)
          end try
          try
            set descriptionValue to my cleanText(description of elementRef)
          end try
          try
            set enabledValue to enabled of elementRef
          end try
          if subroleValue is not "AXSecureTextField" then
            set end of outputLines to "EL" & tab & elementIndex & tab & roleValue & tab & subroleValue & tab & titleValue & tab & descriptionValue & tab & enabledValue
            set emittedCount to emittedCount + 1
          end if
        end if
      end try
    end repeat

    set previousDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to linefeed
    set outputText to outputLines as text
    set AppleScript's text item delimiters to previousDelimiters
    return outputText
  end tell
end run
`;

const PRESS_ELEMENT_SCRIPT = `
${TEXT_HELPERS}

on isSupportedRole(roleValue)
  return roleValue is in {"AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXDisclosureTriangle"}
end isSupportedRole

on run argv
  if (count of argv) is not 5 then error "Invalid desktop action arguments"
  set expectedBundleId to item 1 of argv
  set elementIndex to item 2 of argv as integer
  set expectedRole to item 3 of argv
  set expectedTitle to item 4 of argv
  set expectedWindowTitle to item 5 of argv

  tell application "System Events"
    set frontProcess to first application process whose frontmost is true
    set actualBundleId to ""
    try
      set actualBundleId to bundle identifier of frontProcess as text
    end try
    if actualBundleId is not expectedBundleId then error "Frontmost application changed"
    set actualWindowTitle to ""
    try
      set actualWindowTitle to my cleanText(name of front window of frontProcess)
    end try
    if expectedWindowTitle is not "" and actualWindowTitle is not expectedWindowTitle then error "Frontmost application window changed"

    set allElements to entire contents of front window of frontProcess
    if elementIndex < 1 or elementIndex > count of allElements then error "Desktop target is stale"
    set targetElement to item elementIndex of allElements
    set actualRole to my cleanText(role of targetElement)
    if actualRole is not expectedRole then error "Desktop target role changed"
    if not my isSupportedRole(actualRole) then error "Unsupported desktop target role"

    set actualSubrole to ""
    set actualTitle to ""
    set enabledValue to true
    try
      set actualSubrole to my cleanText(subrole of targetElement)
    end try
    if actualSubrole is "AXSecureTextField" then error "Secure fields are prohibited"
    try
      set actualTitle to my cleanText(title of targetElement)
    end try
    try
      if actualTitle is "" then set actualTitle to my cleanText(name of targetElement)
    end try
    if actualTitle is not expectedTitle then error "Desktop target title changed"
    try
      set enabledValue to enabled of targetElement
    end try
    if enabledValue is false then error "Desktop target is disabled"

    perform action "AXPress" of targetElement
    return "pressed"
  end tell
end run
`;

export interface DesktopAutomationAdapterElement {
  index: number;
  role: DesktopAutomationElementRole;
  title: string;
  description?: string;
  enabled: boolean;
}

export interface DesktopAutomationAdapterInspection {
  app: DesktopAutomationApp;
  elements: DesktopAutomationAdapterElement[];
  truncated: boolean;
}

export interface DesktopAutomationAdapterCapture {
  app: DesktopAutomationApp;
  image: Buffer;
}

export interface DesktopAutomationAdapter {
  readonly supported: boolean;
  getPermissions(): Promise<DesktopAutomationPermissions>;
  requestPermission(
    permission: DesktopAutomationPermissionKind,
  ): Promise<DesktopAutomationPermissions>;
  openPermissionSettings(
    permission: DesktopAutomationPermissionKind,
  ): Promise<void>;
  getFrontmostApp(): Promise<DesktopAutomationApp>;
  inspectFrontmostApp(
    maxElements: number,
  ): Promise<DesktopAutomationAdapterInspection>;
  captureFrontmostApp(): Promise<DesktopAutomationAdapterCapture>;
  pressElement(input: {
    app: DesktopAutomationApp;
    index: number;
    role: DesktopAutomationElementRole;
    title: string;
  }): Promise<void>;
  registerKillSwitch(callback: () => void): boolean;
  unregisterKillSwitch(): void;
}

export function createDesktopAutomationAdapter(
  platform = process.platform,
): DesktopAutomationAdapter {
  if (platform !== 'darwin') return new UnsupportedDesktopAutomationAdapter();
  return new MacDesktopAutomationAdapter();
}

class UnsupportedDesktopAutomationAdapter implements DesktopAutomationAdapter {
  public readonly supported = false;

  public async getPermissions(): Promise<DesktopAutomationPermissions> {
    return {
      screenRecording: 'unsupported',
      accessibility: 'unsupported',
      checkedAt: Date.now(),
    };
  }

  public async requestPermission(): Promise<DesktopAutomationPermissions> {
    return this.getPermissions();
  }

  public async openPermissionSettings(): Promise<void> {
    throw new Error('Desktop automation is supported only on macOS');
  }

  public async getFrontmostApp(): Promise<DesktopAutomationApp> {
    throw new Error('Desktop automation is supported only on macOS');
  }

  public async inspectFrontmostApp(): Promise<DesktopAutomationAdapterInspection> {
    throw new Error('Desktop automation is supported only on macOS');
  }

  public async captureFrontmostApp(): Promise<DesktopAutomationAdapterCapture> {
    throw new Error('Desktop automation is supported only on macOS');
  }

  public async pressElement(): Promise<void> {
    throw new Error('Desktop automation is supported only on macOS');
  }

  public registerKillSwitch(): boolean {
    return false;
  }

  public unregisterKillSwitch(): void {}
}

class MacDesktopAutomationAdapter implements DesktopAutomationAdapter {
  public readonly supported = true;

  public async getPermissions(): Promise<DesktopAutomationPermissions> {
    return {
      screenRecording: systemPreferences.getMediaAccessStatus('screen'),
      accessibility: systemPreferences.isTrustedAccessibilityClient(false)
        ? 'granted'
        : 'denied',
      checkedAt: Date.now(),
    };
  }

  public async requestPermission(
    permission: DesktopAutomationPermissionKind,
  ): Promise<DesktopAutomationPermissions> {
    if (permission === 'accessibility') {
      systemPreferences.isTrustedAccessibilityClient(true);
    } else {
      await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
      });
    }
    return this.getPermissions();
  }

  public async openPermissionSettings(
    permission: DesktopAutomationPermissionKind,
  ): Promise<void> {
    const pane =
      permission === 'screen-recording'
        ? 'Privacy_ScreenCapture'
        : 'Privacy_Accessibility';
    await shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${pane}`,
    );
  }

  public async getFrontmostApp(): Promise<DesktopAutomationApp> {
    const output = await runStaticAppleScript(FRONTMOST_APP_SCRIPT);
    return parseAppLine(output.trim().split(/\r?\n/, 1)[0] ?? '');
  }

  public async inspectFrontmostApp(
    maxElements: number,
  ): Promise<DesktopAutomationAdapterInspection> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(maxElements)));
    const output = await runStaticAppleScript(
      INSPECT_FRONTMOST_APP_SCRIPT,
      String(boundedLimit),
    );
    const lines = output.trim().split(/\r?\n/);
    const app = parseAppLine(lines.shift() ?? '');
    const elements: DesktopAutomationAdapterElement[] = [];

    for (const line of lines) {
      const [
        marker,
        rawIndex,
        rawRole,
        _subrole,
        title = '',
        description = '',
        rawEnabled = 'false',
      ] = line.split('\t');
      if (marker !== 'EL') continue;
      if (!isSupportedRole(rawRole)) continue;
      const index = Number.parseInt(rawIndex ?? '', 10);
      if (!Number.isInteger(index) || index < 1) continue;
      elements.push({
        index,
        role: rawRole,
        title: title.slice(0, 200),
        description: description ? description.slice(0, 300) : undefined,
        enabled: rawEnabled === 'true',
      });
    }

    return {
      app,
      elements,
      truncated: elements.length >= boundedLimit,
    };
  }

  public async captureFrontmostApp(): Promise<DesktopAutomationAdapterCapture> {
    const app = await this.getFrontmostApp();
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: {
        width: CAPTURE_MAX_WIDTH,
        height: CAPTURE_MAX_HEIGHT,
      },
      fetchWindowIcons: false,
    });
    const source = selectUniqueDesktopCaptureSource(sources, app);
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('Frontmost application window is not capturable');
    }
    const image = source.thumbnail.toPNG();
    if (image.length === 0 || image.length > CAPTURE_MAX_BYTES) {
      throw new Error('Desktop capture exceeded the bounded image size');
    }
    const currentApp = await this.getFrontmostApp();
    if (
      currentApp.bundleId !== app.bundleId ||
      normalizeWindowTitle(currentApp.windowTitle) !==
        normalizeWindowTitle(app.windowTitle)
    ) {
      throw new Error('Frontmost application window changed during capture');
    }
    return { app, image };
  }

  public async pressElement(input: {
    app: DesktopAutomationApp;
    index: number;
    role: DesktopAutomationElementRole;
    title: string;
  }): Promise<void> {
    await runStaticAppleScript(
      PRESS_ELEMENT_SCRIPT,
      input.app.bundleId,
      String(input.index),
      input.role,
      input.title,
      input.app.windowTitle ?? '',
    );
  }

  public registerKillSwitch(callback: () => void): boolean {
    return globalShortcut.register(
      DESKTOP_AUTOMATION_KILL_SWITCH_ACCELERATOR,
      callback,
    );
  }

  public unregisterKillSwitch(): void {
    globalShortcut.unregister(DESKTOP_AUTOMATION_KILL_SWITCH_ACCELERATOR);
  }
}

function runStaticAppleScript(
  script: string,
  ...args: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      OSASCRIPT_PATH,
      ['-e', script, '--', ...args],
      {
        timeout: APPLE_SCRIPT_TIMEOUT_MS,
        maxBuffer: APPLE_SCRIPT_MAX_BUFFER,
        encoding: 'utf-8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Static AppleScript failed: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseAppLine(line: string): DesktopAutomationApp {
  const [markerOrName = '', second = '', third = '', fourth = ''] =
    line.split('\t');
  const hasMarker = markerOrName === 'APP';
  const name = hasMarker ? second : markerOrName;
  const bundleId = hasMarker ? third : second;
  const windowTitle = hasMarker ? fourth : third;
  if (!name || !bundleId) {
    throw new Error('Unable to identify the frontmost macOS application');
  }
  return {
    name: name.slice(0, 160),
    bundleId: bundleId.slice(0, 255),
    windowTitle: windowTitle ? windowTitle.slice(0, 500) : undefined,
  };
}

function isSupportedRole(
  value: string | undefined,
): value is DesktopAutomationElementRole {
  return (
    value === 'AXButton' ||
    value === 'AXCheckBox' ||
    value === 'AXRadioButton' ||
    value === 'AXPopUpButton' ||
    value === 'AXMenuButton' ||
    value === 'AXLink' ||
    value === 'AXDisclosureTriangle'
  );
}

function normalizeWindowTitle(title: string | undefined): string {
  return (title ?? '').trim().toLocaleLowerCase();
}
