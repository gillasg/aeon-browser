// Windows Common Item Dialog: the Explorer-style picker, without a PowerShell 7 dependency.
export const windowsFolderDialogSource = String.raw`
using System;
using System.Runtime.InteropServices;
public static class PiperFolderDialog {
  public static string Choose(IntPtr owner) {
    var dialog = (IFileOpenDialog)new FileOpenDialog();
    IShellItem item = null;
    try {
      dialog.SetOptions(0x00000860);
      dialog.SetTitle("Choose project folder");
      dialog.SetOkButtonLabel("Select folder");
      int result = dialog.Show(owner);
      if (result == unchecked((int)0x800704C7)) return null;
      Marshal.ThrowExceptionForHR(result);
      dialog.GetResult(out item);
      IntPtr path;
      item.GetDisplayName(0x80058000, out path);
      try { return Marshal.PtrToStringUni(path); }
      finally { Marshal.FreeCoTaskMem(path); }
    } finally {
      if (item != null) Marshal.ReleaseComObject(item);
      Marshal.ReleaseComObject(dialog);
    }
  }
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] private class FileOpenDialog { }
  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem folder);
    void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName(out IntPtr name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, int alignment);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IntPtr items);
    void GetSelectedItems(out IntPtr items);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint kind, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }
}
`;
