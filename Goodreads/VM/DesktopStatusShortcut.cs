using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Only used by the per-user installer to identify its Start Menu shortcut.
public static class GoodreadsStatusShortcut
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PropertyKey { public Guid Format; public uint Id; }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    public struct PropVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Pointer;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore
    {
        uint GetCount();
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr binding, uint flags,
        ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint length, uint flags);

    public static string PhysicalPath(string path)
    {
        using (var file = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            var result = new StringBuilder(32768);
            if (GetFinalPathNameByHandle(file.SafeFileHandle.DangerousGetHandle(), result, (uint)result.Capacity, 0) == 0)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            string physical = result.ToString();
            return physical.StartsWith(@"\\?\") ? physical.Substring(4) : physical;
        }
    }

    public static void Register(string shortcut, string appId, string activator)
    {
        Guid interfaceId = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        SHGetPropertyStoreFromParsingName(shortcut, IntPtr.Zero, 2, ref interfaceId, out store);
        try
        {
            var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
            var value = new PropVariant { Type = 31, Pointer = Marshal.StringToCoTaskMemUni(appId) };
            try { store.SetValue(ref key, ref value); }
            finally { PropVariantClear(ref value); }
            key.Id = 26;
            value = new PropVariant { Type = 72, Pointer = Marshal.AllocCoTaskMem(16) };
            Marshal.StructureToPtr(new Guid(activator), value.Pointer, false);
            try { store.SetValue(ref key, ref value); }
            finally { PropVariantClear(ref value); }
            store.Commit();
        }
        finally { Marshal.ReleaseComObject(store); }
    }
}
