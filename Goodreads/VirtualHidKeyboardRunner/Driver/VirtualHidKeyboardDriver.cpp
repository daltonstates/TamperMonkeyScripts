#include "VirtualHidKeyboardDriver.h"

// Standard 8-byte boot-keyboard input report: modifier byte, reserved byte,
// and six simultaneous non-modifier HID usage slots.
static UCHAR g_KeyboardReportDescriptor[] = {
    0x05, 0x01,       // USAGE_PAGE (Generic Desktop)
    0x09, 0x06,       // USAGE (Keyboard)
    0xA1, 0x01,       // COLLECTION (Application)
    0x05, 0x07,       //   USAGE_PAGE (Keyboard/Keypad)
    0x19, 0xE0,       //   USAGE_MINIMUM (Keyboard LeftControl)
    0x29, 0xE7,       //   USAGE_MAXIMUM (Keyboard Right GUI)
    0x15, 0x00,       //   LOGICAL_MINIMUM (0)
    0x25, 0x01,       //   LOGICAL_MAXIMUM (1)
    0x75, 0x01,       //   REPORT_SIZE (1)
    0x95, 0x08,       //   REPORT_COUNT (8)
    0x81, 0x02,       //   INPUT (Data,Var,Abs) - modifier bits
    0x95, 0x01,       //   REPORT_COUNT (1)
    0x75, 0x08,       //   REPORT_SIZE (8)
    0x81, 0x01,       //   INPUT (Constant) - reserved byte
    0x95, 0x06,       //   REPORT_COUNT (6)
    0x75, 0x08,       //   REPORT_SIZE (8)
    0x15, 0x00,       //   LOGICAL_MINIMUM (0)
    0x25, 0x65,       //   LOGICAL_MAXIMUM (Keyboard Application)
    0x19, 0x00,       //   USAGE_MINIMUM (Reserved)
    0x29, 0x65,       //   USAGE_MAXIMUM (Keyboard Application)
    0x81, 0x00,       //   INPUT (Data,Array,Abs) - key usages
    0xC0              // END_COLLECTION
};

extern "C"
NTSTATUS
DriverEntry(
    _In_ PDRIVER_OBJECT DriverObject,
    _In_ PUNICODE_STRING RegistryPath)
{
    WDF_DRIVER_CONFIG driverConfig;
    WDF_DRIVER_CONFIG_INIT(&driverConfig, VirtualHidKeyboardEvtDeviceAdd);

    return WdfDriverCreate(
        DriverObject,
        RegistryPath,
        WDF_NO_OBJECT_ATTRIBUTES,
        &driverConfig,
        WDF_NO_HANDLE);
}

NTSTATUS
VirtualHidKeyboardEvtDeviceAdd(
    _In_ WDFDRIVER Driver,
    _Inout_ PWDFDEVICE_INIT DeviceInit)
{
    UNREFERENCED_PARAMETER(Driver);

    NTSTATUS status;
    WDF_OBJECT_ATTRIBUTES deviceAttributes;
    WDF_FILEOBJECT_CONFIG fileObjectConfig;
    WDFDEVICE device;
    WDF_IO_QUEUE_CONFIG queueConfig;
    VHF_CONFIG vhfConfig;
    PDEVICE_CONTEXT deviceContext;
    DECLARE_CONST_UNICODE_STRING(deviceSddl, L"D:P(A;;GA;;;SY)(A;;GA;;;BA)");
    DECLARE_CONST_UNICODE_STRING(controlLink, L"\\DosDevices\\VirtualHidKeyboardControl");

    WdfDeviceInitSetDeviceType(DeviceInit, FILE_DEVICE_UNKNOWN);
    status = WdfDeviceInitAssignSDDLString(DeviceInit, &deviceSddl);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    WDF_FILEOBJECT_CONFIG_INIT(
        &fileObjectConfig,
        WDF_NO_EVENT_CALLBACK,
        WDF_NO_EVENT_CALLBACK,
        VirtualHidKeyboardEvtFileCleanup);
    WdfDeviceInitSetFileObjectConfig(
        DeviceInit,
        &fileObjectConfig,
        WDF_NO_OBJECT_ATTRIBUTES);

    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&deviceAttributes, DEVICE_CONTEXT);
    deviceAttributes.EvtCleanupCallback = VirtualHidKeyboardEvtDeviceCleanup;
    status = WdfDeviceCreate(&DeviceInit, &deviceAttributes, &device);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    status = WdfDeviceCreateSymbolicLink(device, &controlLink);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    WDF_IO_QUEUE_CONFIG_INIT_DEFAULT_QUEUE(&queueConfig, WdfIoQueueDispatchSequential);
    queueConfig.EvtIoDeviceControl = VirtualHidKeyboardEvtIoDeviceControl;
    status = WdfIoQueueCreate(device, &queueConfig, WDF_NO_OBJECT_ATTRIBUTES, WDF_NO_HANDLE);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    deviceContext = VirtualHidKeyboardGetContext(device);
    VHF_CONFIG_INIT(
        &vhfConfig,
        WdfDeviceWdmGetDeviceObject(device),
        sizeof(g_KeyboardReportDescriptor),
        g_KeyboardReportDescriptor);

    status = VhfCreate(&vhfConfig, &deviceContext->VhfHandle);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    status = VhfStart(deviceContext->VhfHandle);
    return status;
}

VOID
VirtualHidKeyboardEvtFileCleanup(
    _In_ WDFFILEOBJECT FileObject)
{
    WDFDEVICE device = WdfFileObjectGetDevice(FileObject);
    PDEVICE_CONTEXT deviceContext = VirtualHidKeyboardGetContext(device);
    if (deviceContext->VhfHandle == nullptr) {
        return;
    }

    const VHK_BOOT_KEYBOARD_REPORT releaseReport = {};
    (void)VirtualHidKeyboardSubmitReport(deviceContext, &releaseReport);
}

VOID
VirtualHidKeyboardEvtDeviceCleanup(
    _In_ WDFOBJECT DeviceObject)
{
    PDEVICE_CONTEXT deviceContext = VirtualHidKeyboardGetContext(DeviceObject);
    if (deviceContext->VhfHandle != nullptr) {
        VhfDelete(deviceContext->VhfHandle, TRUE);
        deviceContext->VhfHandle = nullptr;
    }
}

VOID
VirtualHidKeyboardEvtIoDeviceControl(
    _In_ WDFQUEUE Queue,
    _In_ WDFREQUEST Request,
    _In_ size_t OutputBufferLength,
    _In_ size_t InputBufferLength,
    _In_ ULONG IoControlCode)
{
    UNREFERENCED_PARAMETER(OutputBufferLength);

    if (IoControlCode != IOCTL_VHK_SUBMIT_REPORT) {
        WdfRequestComplete(Request, STATUS_INVALID_DEVICE_REQUEST);
        return;
    }

    if (InputBufferLength != sizeof(VHK_BOOT_KEYBOARD_REPORT)) {
        WdfRequestComplete(Request, STATUS_INVALID_BUFFER_SIZE);
        return;
    }

    PVOID reportBuffer = nullptr;
    NTSTATUS status = WdfRequestRetrieveInputBuffer(
        Request,
        sizeof(VHK_BOOT_KEYBOARD_REPORT),
        &reportBuffer,
        nullptr);
    if (NT_SUCCESS(status)) {
        PVHK_BOOT_KEYBOARD_REPORT report = static_cast<PVHK_BOOT_KEYBOARD_REPORT>(reportBuffer);
        if (report->Reserved != 0) {
            status = STATUS_INVALID_PARAMETER;
        } else {
            PDEVICE_CONTEXT deviceContext = VirtualHidKeyboardGetContext(WdfIoQueueGetDevice(Queue));
            status = VirtualHidKeyboardSubmitReport(deviceContext, report);
        }
    }

    WdfRequestComplete(Request, status);
}

NTSTATUS
VirtualHidKeyboardSubmitReport(
    _In_ PDEVICE_CONTEXT DeviceContext,
    _In_ const VHK_BOOT_KEYBOARD_REPORT* Report)
{
    HID_XFER_PACKET transferPacket;
    RtlZeroMemory(&transferPacket, sizeof(transferPacket));
    transferPacket.reportId = 0;
    transferPacket.reportBuffer = const_cast<PUCHAR>(reinterpret_cast<const UCHAR*>(Report));
    transferPacket.reportBufferLen = sizeof(*Report);

    return VhfReadReportSubmit(DeviceContext->VhfHandle, &transferPacket);
}
