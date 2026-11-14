//go:build gui && windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"

	"github.com/tailscale/win"
)

const (
	fosPickFolders      = 0x00000020
	fosForceFileSystem  = 0x00000040
	fosAllowMultiSelect = 0x00000200
	fosPathMustExist    = 0x00000800
	fosFileMustExist    = 0x00001000
	fosNoChangeDir      = 0x00000008
	sigdnFileSysPath    = 0x80058000
	hresultCancelled    = 0x800704C7
	rpcEChangedMode     = 0x80010106
)

// IFileOpenDialog vtable. Order matches the COM interface, including the
// inherited IFileDialog and IModalWindow methods.
type fileOpenDialogVtbl struct {
	QueryInterface      uintptr
	AddRef              uintptr
	Release             uintptr
	Show                uintptr
	SetFileTypes        uintptr
	SetFileTypeIndex    uintptr
	GetFileTypeIndex    uintptr
	Advise              uintptr
	Unadvise            uintptr
	SetOptions          uintptr
	GetOptions          uintptr
	SetDefaultFolder    uintptr
	SetFolder           uintptr
	GetFolder           uintptr
	GetCurrentSelection uintptr
	SetFileName         uintptr
	GetFileName         uintptr
	SetTitle            uintptr
	SetOkButtonLabel    uintptr
	SetFileNameLabel    uintptr
	GetResult           uintptr
	AddPlace            uintptr
	SetDefaultExtension uintptr
	Close               uintptr
	SetClientGuid       uintptr
	ClearClientData     uintptr
	SetFilter           uintptr
	GetResults          uintptr
	GetSelectedItems    uintptr
}

type fileOpenDialog struct {
	vtbl *fileOpenDialogVtbl
}

type shellItemVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
	BindToHandler  uintptr
	GetParent      uintptr
	GetDisplayName uintptr
	GetAttributes  uintptr
	Compare        uintptr
}

type shellItem struct {
	vtbl *shellItemVtbl
}

type shellItemArrayVtbl struct {
	QueryInterface             uintptr
	AddRef                     uintptr
	Release                    uintptr
	BindToHandler              uintptr
	GetPropertyStore           uintptr
	GetPropertyDescriptionList uintptr
	GetAttributes              uintptr
	GetCount                   uintptr
	GetItemAt                  uintptr
	EnumItems                  uintptr
}

type shellItemArray struct {
	vtbl *shellItemArrayVtbl
}

var (
	shell32Pick                 = syscall.NewLazyDLL("shell32.dll")
	shCreateItemFromParsingName = shell32Pick.NewProc("SHCreateItemFromParsingName")
	clsidFileOpenDialog         = win.CLSID{Data1: 0xDC1C5A9C, Data2: 0xE88A, Data3: 0x4DDE, Data4: [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	iidFileOpenDialog           = win.IID{Data1: 0xD57C7288, Data2: 0xD4AD, Data3: 0x4768, Data4: [8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60}}
	iidShellItem                = win.IID{Data1: 0x43826D1E, Data2: 0xE718, Data3: 0x42EE, Data4: [8]byte{0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE}}
)

// pickFolders opens the modern multi-select folder dialog. Cancelling returns
// an empty list and a nil error.
func pickFolders(owner win.HWND, initialDir string) ([]string, error) {
	hr := win.CoInitializeEx(nil, win.COINIT_APARTMENTTHREADED|win.COINIT_DISABLE_OLE1DDE)
	if win.SUCCEEDED(hr) {
		defer win.CoUninitialize()
	} else if uint32(hr) != rpcEChangedMode {
		return nil, fmt.Errorf("无法初始化文件夹选择器（0x%08X）", uint32(hr))
	} else {
		return nil, fmt.Errorf("无法打开文件夹选择器：当前线程的 COM 模式不受支持")
	}

	var raw unsafe.Pointer
	hr = win.CoCreateInstance(&clsidFileOpenDialog, nil, win.CLSCTX_INPROC_SERVER, &iidFileOpenDialog, &raw)
	if win.FAILED(hr) || raw == nil {
		return nil, fmt.Errorf("无法创建文件夹选择器（0x%08X）", uint32(hr))
	}
	dialog := (*fileOpenDialog)(raw)
	defer releaseCOM(raw, dialog.vtbl.Release)

	var options uint32
	if hr = callCOM(dialog.vtbl.GetOptions, uintptr(raw), uintptr(unsafe.Pointer(&options))); win.FAILED(hr) {
		return nil, fmt.Errorf("无法配置文件夹选择器（0x%08X）", uint32(hr))
	}
	options &^= fosFileMustExist
	options |= fosPickFolders | fosForceFileSystem | fosAllowMultiSelect | fosPathMustExist | fosNoChangeDir
	if hr = callCOM(dialog.vtbl.SetOptions, uintptr(raw), uintptr(options)); win.FAILED(hr) {
		return nil, fmt.Errorf("无法配置文件夹选择器（0x%08X）", uint32(hr))
	}
	title, err := syscall.UTF16PtrFromString("选择要排除的目录")
	if err != nil {
		return nil, err
	}
	if hr = callCOM(dialog.vtbl.SetTitle, uintptr(raw), uintptr(unsafe.Pointer(title))); win.FAILED(hr) {
		return nil, fmt.Errorf("无法配置文件夹选择器（0x%08X）", uint32(hr))
	}
	if item, itemErr := shellItemFromPath(initialDir); itemErr == nil {
		_ = callCOM(dialog.vtbl.SetFolder, uintptr(raw), uintptr(unsafe.Pointer(item)))
		releaseCOM(unsafe.Pointer(item), item.vtbl.Release)
	}

	hr = callCOM(dialog.vtbl.Show, uintptr(raw), uintptr(owner))
	if uint32(hr) == hresultCancelled {
		return nil, nil
	}
	if win.FAILED(hr) {
		return nil, fmt.Errorf("无法打开文件夹选择器（0x%08X）", uint32(hr))
	}

	var items *shellItemArray
	if hr = callCOM(dialog.vtbl.GetResults, uintptr(raw), uintptr(unsafe.Pointer(&items))); win.FAILED(hr) || items == nil {
		return nil, fmt.Errorf("无法读取所选目录（0x%08X）", uint32(hr))
	}
	defer releaseCOM(unsafe.Pointer(items), items.vtbl.Release)

	var count uint32
	if hr = callCOM(items.vtbl.GetCount, uintptr(unsafe.Pointer(items)), uintptr(unsafe.Pointer(&count))); win.FAILED(hr) {
		return nil, fmt.Errorf("无法读取所选目录（0x%08X）", uint32(hr))
	}
	paths := make([]string, 0, count)
	for index := uint32(0); index < count; index++ {
		var item *shellItem
		if hr = callCOM(items.vtbl.GetItemAt, uintptr(unsafe.Pointer(items)), uintptr(index), uintptr(unsafe.Pointer(&item))); win.FAILED(hr) || item == nil {
			return nil, fmt.Errorf("无法读取所选目录（0x%08X）", uint32(hr))
		}
		path, pathErr := shellItemPath(item)
		releaseCOM(unsafe.Pointer(item), item.vtbl.Release)
		if pathErr != nil {
			return nil, pathErr
		}
		if path != "" {
			paths = append(paths, path)
		}
	}
	return paths, nil
}

func shellItemFromPath(path string) (*shellItem, error) {
	if path == "" {
		return nil, fmt.Errorf("路径为空")
	}
	ptr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	var item *shellItem
	r, _, _ := shCreateItemFromParsingName.Call(
		uintptr(unsafe.Pointer(ptr)),
		0,
		uintptr(unsafe.Pointer(&iidShellItem)),
		uintptr(unsafe.Pointer(&item)),
	)
	if win.FAILED(hresultOf(r)) || item == nil {
		return nil, fmt.Errorf("无法打开目录")
	}
	return item, nil
}

func shellItemPath(item *shellItem) (string, error) {
	var name *uint16
	hr := callCOM(item.vtbl.GetDisplayName, uintptr(unsafe.Pointer(item)), sigdnFileSysPath, uintptr(unsafe.Pointer(&name)))
	if name != nil {
		defer win.CoTaskMemFree(uintptr(unsafe.Pointer(name)))
	}
	if win.FAILED(hr) {
		return "", fmt.Errorf("无法读取所选目录（0x%08X）", uint32(hr))
	}
	return win.UTF16PtrToString(name), nil
}

func callCOM(fn uintptr, args ...uintptr) win.HRESULT {
	r, _, _ := syscall.SyscallN(fn, args...)
	return hresultOf(r)
}

func hresultOf(r uintptr) win.HRESULT {
	return win.HRESULT(int32(uint32(r)))
}

func releaseCOM(obj unsafe.Pointer, release uintptr) {
	if obj == nil || release == 0 {
		return
	}
	_, _, _ = syscall.SyscallN(release, uintptr(obj))
}
