#pragma once

#include <ntddk.h>
#include <wdf.h>
#include <vhf.h>
#include "VirtualHidKeyboardProtocol.h"

typedef struct _DEVICE_CONTEXT {
    VHFHANDLE VhfHandle;
} DEVICE_CONTEXT, *PDEVICE_CONTEXT;

WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(DEVICE_CONTEXT, VirtualHidKeyboardGetContext);

extern "C" DRIVER_INITIALIZE DriverEntry;
EVT_WDF_DRIVER_DEVICE_ADD VirtualHidKeyboardEvtDeviceAdd;
EVT_WDF_IO_QUEUE_IO_DEVICE_CONTROL VirtualHidKeyboardEvtIoDeviceControl;
EVT_WDF_FILE_CLEANUP VirtualHidKeyboardEvtFileCleanup;
EVT_WDF_OBJECT_CONTEXT_CLEANUP VirtualHidKeyboardEvtDeviceCleanup;

_Must_inspect_result_
NTSTATUS
VirtualHidKeyboardSubmitReport(
    _In_ PDEVICE_CONTEXT DeviceContext,
    _In_ const VHK_BOOT_KEYBOARD_REPORT* Report);
