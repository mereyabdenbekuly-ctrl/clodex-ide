/** Types of permissions that can be requested */
export type PermissionRequestType =
  | 'media'
  | 'geolocation'
  | 'notifications'
  | 'fullscreen'
  | 'bluetooth'
  | 'hid'
  | 'serial'
  | 'usb'
  | 'bluetooth-pairing'
  | 'clipboard-read'
  | 'display-capture'
  | 'midi'
  | 'idle-detection'
  | 'speaker-selection'
  | 'storage-access';

/** Media types for camera/microphone distinction */
export type MediaType = 'video' | 'audio'; // video = camera, audio = microphone

/** Base permission request with shared properties */
export interface BasePermissionRequest {
  /** Unique identifier for this request */
  id: string;
  /** Timestamp when request was created */
  timestamp: number;
  /** The type of permission being requested */
  type: PermissionRequestType;
  /** Origin of the requesting page */
  origin: string;
  /** Tab ID this request belongs to */
  tabId: string;
}

/** Media permission request (camera/microphone) */
export interface MediaPermissionRequest extends BasePermissionRequest {
  type: 'media';
  /** Which media types are being requested: 'video' (camera), 'audio' (microphone), or both */
  mediaTypes: MediaType[];
}

/** Simple yes/no permission request (geolocation, notifications, etc.) */
export interface SimplePermissionRequest extends BasePermissionRequest {
  type:
    | 'geolocation'
    | 'notifications'
    | 'fullscreen'
    | 'clipboard-read'
    | 'display-capture'
    | 'midi'
    | 'idle-detection'
    | 'speaker-selection'
    | 'storage-access';
}

/** Bluetooth device info for UI display */
export interface BluetoothDeviceInfo {
  deviceId: string;
  deviceName: string;
}

/** Bluetooth device selection request */
export interface BluetoothSelectionRequest extends BasePermissionRequest {
  type: 'bluetooth';
  /** Available Bluetooth devices (updated every 200ms during selection) */
  devices: BluetoothDeviceInfo[];
}

/** Bluetooth pairing request (Windows/Linux) */
export interface BluetoothPairingRequest extends BasePermissionRequest {
  type: 'bluetooth-pairing';
  deviceId: string;
  pairingKind: 'confirm' | 'confirmPin' | 'providePin';
  /** PIN to confirm (for confirmPin mode) */
  pin?: string;
}

/** HID device info */
export interface HIDDeviceInfo {
  deviceId: string;
  vendorId: number;
  productId: number;
  productName: string;
}

/** HID device selection request */
export interface HIDSelectionRequest extends BasePermissionRequest {
  type: 'hid';
  devices: HIDDeviceInfo[];
}

/** Serial port info */
export interface SerialPortInfo {
  portId: string;
  portName: string;
  displayName: string;
}

/** Serial port selection request */
export interface SerialSelectionRequest extends BasePermissionRequest {
  type: 'serial';
  ports: SerialPortInfo[];
}

/** USB device info */
export interface USBDeviceInfo {
  deviceId: string;
  vendorId: number;
  productId: number;
  productName: string;
  manufacturerName?: string;
}

/** USB device selection request */
export interface USBSelectionRequest extends BasePermissionRequest {
  type: 'usb';
  devices: USBDeviceInfo[];
}

/** Union type for all permission requests */
export type PermissionRequest =
  | MediaPermissionRequest
  | SimplePermissionRequest
  | BluetoothSelectionRequest
  | BluetoothPairingRequest
  | HIDSelectionRequest
  | SerialSelectionRequest
  | USBSelectionRequest;

/** Request for HTTP Basic Authentication credentials */
export interface AuthenticationRequest {
  /** Unique identifier for this request */
  id: string;
  /** Timestamp when request was created */
  timestamp: number;
  /** The URL that triggered the authentication request */
  url: string;
  /** Origin of the URL (protocol + host) */
  origin: string;
  /** The realm string from the WWW-Authenticate header */
  realm?: string;
  /** The host requesting authentication */
  host: string;
  /** Tab ID this request belongs to */
  tabId: string;
}
