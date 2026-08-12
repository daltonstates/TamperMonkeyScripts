#pragma once

// Private controller-to-driver protocol. This is not a Logitech protocol and
// the virtual device remains a separately enumerated standard HID keyboard.
#define VHK_FILE_DEVICE 0x00008337
#define IOCTL_VHK_SUBMIT_REPORT \
    CTL_CODE(VHK_FILE_DEVICE, 0x800, METHOD_BUFFERED, FILE_WRITE_DATA)

#pragma pack(push, 1)
typedef struct _VHK_BOOT_KEYBOARD_REPORT {
    UCHAR Modifier;
    UCHAR Reserved;
    UCHAR KeyUsage[6];
} VHK_BOOT_KEYBOARD_REPORT, *PVHK_BOOT_KEYBOARD_REPORT;
#pragma pack(pop)

C_ASSERT(sizeof(VHK_BOOT_KEYBOARD_REPORT) == 8);
