#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <shellapi.h>
#include <shobjidl.h>
#include <notificationactivationcallback.h>
#include <windows.ui.notifications.h>
#include <windows.data.xml.dom.h>
#include <wrl.h>
#include <wrl/module.h>
#include <wrl/wrappers/corewrappers.h>
#include <fstream>
#include <string>
#include <sstream>
#include <iomanip>

using namespace Microsoft::WRL;
static const wchar_t AppId[] = L"GoodreadsGiveaways.RunReport";
static DWORD mainThread;
static std::wstring Root()
{
    wchar_t path[32768]; DWORD length = GetModuleFileNameW(nullptr, path, ARRAYSIZE(path));
    if(!length || length >= ARRAYSIZE(path)) return L"";
    std::wstring value(path); return value.substr(0, value.find_last_of(L"\\/"));
}
static std::wstring Json(const std::wstring& value)
{
    std::wstring result;
    for (auto c : value) { if (c == L'\\' || c == L'"') result += L'\\'; if(c == L'\n') result += L"\\n"; else if(c == L'\r') result += L"\\r"; else result += c; }
    return result;
}
static void Record(const wchar_t* state, const wchar_t* source, HRESULT error = S_OK, bool latest = true)
{
    SYSTEMTIME now; GetSystemTime(&now);
    std::wostringstream content;
    content << L"{\"at\":\"" << now.wYear << L'-' << std::setfill(L'0') << std::setw(2) << now.wMonth << L'-' << std::setw(2) << now.wDay
        << L'T' << std::setw(2) << now.wHour << L':' << std::setw(2) << now.wMinute << L':' << std::setw(2) << now.wSecond << L"Z\",\"state\":\""
        << state << L"\",\"source\":\"" << source << L"\",\"processId\":" << GetCurrentProcessId() << L",\"hresult\":\"0x" << std::hex << error
        << L"\",\"report\":\"" << Json(Root() + L"\\report.html") << L"\"}";
    auto value = content.str(); int length = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string utf8(length, '\0'); WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, &utf8[0], length, nullptr, nullptr);
    if(Root().empty()) return;
    auto write = [&](const std::wstring& path) { auto temp = path + L"." + std::to_wstring(GetCurrentProcessId()) + L".tmp"; HANDLE file = CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr); if(file != INVALID_HANDLE_VALUE) { DWORD written; BOOL ok = WriteFile(file, utf8.data(), static_cast<DWORD>(utf8.size() - 1), &written, nullptr); CloseHandle(file); if(ok) MoveFileExW(temp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH); } };
    write(Root() + L"\\native-activation-trace-" + std::to_wstring(GetCurrentProcessId()) + L".json");
    if(latest) write(Root() + L"\\notification-activation.json");
}
static HRESULT Open(const wchar_t* source)
{
    if(Root().empty()) return E_UNEXPECTED;
    std::wstring path = Root() + L"\\report.html";
    if(GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES) { auto hr = HRESULT_FROM_WIN32(GetLastError()); Record(L"failed", source, hr); return hr; }
    SHELLEXECUTEINFOW info = { sizeof(info) }; info.fMask = SEE_MASK_NOASYNC; info.lpVerb = L"open"; info.lpFile = path.c_str(); info.nShow = SW_SHOWNORMAL;
    if(!ShellExecuteExW(&info)) { auto hr = HRESULT_FROM_WIN32(GetLastError()); Record(L"failed", source, hr); return hr; }
    Record(L"launch-requested", source); return S_OK;
}
class __declspec(uuid("17b923a4-29d3-4eaa-8c55-fbd7009e6103")) GoodreadsNotificationCallback final :
    public RuntimeClass<RuntimeClassFlags<ClassicCom>, INotificationActivationCallback>
{
public:
    HRESULT STDMETHODCALLTYPE Activate(LPCWSTR appId, LPCWSTR arguments, const NOTIFICATION_USER_INPUT_DATA*, ULONG) override
    {
        Record(L"callback-received", L"COM"); HRESULT result;
        if(!appId || wcscmp(appId, AppId) || !arguments || (wcscmp(arguments, L"open-report") && wcscmp(arguments, L"verify-open-report")))
        { result = E_INVALIDARG; Record(L"rejected", L"COM", result); }
        else result = Open(wcscmp(arguments, L"open-report") ? L"COM-self-test" : L"notification-click");
        PostThreadMessageW(mainThread, WM_APP + 1, 0, 0); return result;
    }
};
CoCreatableClass(GoodreadsNotificationCallback);

static HRESULT ShowReport(bool quiet)
{
    using namespace ABI::Windows::UI::Notifications;
    using namespace ABI::Windows::Data::Xml::Dom;
    using Microsoft::WRL::Wrappers::HStringReference;
    HRESULT result = RoInitialize(RO_INIT_SINGLETHREADED);
    if(FAILED(result)) return result;
    std::ifstream file(Root() + L"\\notification.xml", std::ios::binary);
    std::string bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
    std::wstring xml(length, L'\0');
    if(!file || !length) result = E_INVALIDARG;
    if(SUCCEEDED(result)) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()), &xml[0], length);
    ComPtr<IInspectable> instance;
    ComPtr<IXmlDocumentIO> xmlIO;
    ComPtr<IXmlDocument> document;
    ComPtr<IToastNotificationManagerStatics> manager;
    ComPtr<IToastNotificationFactory> factory;
    ComPtr<IToastNotifier> notifier;
    ComPtr<IToastNotification> toast;
    ComPtr<IToastNotification2> options;
    if(SUCCEEDED(result)) result = RoActivateInstance(HStringReference(RuntimeClass_Windows_Data_Xml_Dom_XmlDocument).Get(), &instance);
    if(SUCCEEDED(result)) result = instance.As(&xmlIO);
    if(SUCCEEDED(result)) result = xmlIO->LoadXml(HStringReference(xml.c_str(), static_cast<UINT32>(xml.size())).Get());
    if(SUCCEEDED(result)) result = instance.As(&document);
    if(SUCCEEDED(result)) result = RoGetActivationFactory(HStringReference(RuntimeClass_Windows_UI_Notifications_ToastNotificationManager).Get(), IID_PPV_ARGS(&manager));
    if(SUCCEEDED(result)) result = manager->CreateToastNotifierWithId(HStringReference(AppId).Get(), &notifier);
    if(SUCCEEDED(result)) result = RoGetActivationFactory(HStringReference(RuntimeClass_Windows_UI_Notifications_ToastNotification).Get(), IID_PPV_ARGS(&factory));
    if(SUCCEEDED(result)) result = factory->CreateToastNotification(document.Get(), &toast);
    if(SUCCEEDED(result)) result = toast.As(&options);
    if(SUCCEEDED(result)) result = options->put_Tag(HStringReference(L"latest").Get());
    if(SUCCEEDED(result)) result = options->put_Group(HStringReference(L"daily").Get());
    if(SUCCEEDED(result)) result = options->put_SuppressPopup(quiet);
    if(SUCCEEDED(result)) result = notifier->Show(toast.Get());
    NotificationSetting setting;
    if(SUCCEEDED(result)) result = notifier->get_Setting(&setting);
    if(SUCCEEDED(result) && setting != NotificationSetting_Enabled) result = E_ACCESSDENIED;
    Record(SUCCEEDED(result) ? L"submitted" : L"failed", L"native-sender", result, false);
    auto trace = Root() + L"\\native-activation-trace-" + std::to_wstring(GetCurrentProcessId()) + L".json";
    CopyFileW(trace.c_str(), (Root() + L"\\notification-delivery.json").c_str(), FALSE);
    RoUninitialize(); return result;
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR command, int)
{
    HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if(FAILED(result)) { Record(L"failed", L"initialize", result); return 1; }
    mainThread = GetCurrentThreadId();
    SetCurrentProcessExplicitAppUserModelID(AppId);
    int count = 0; auto arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    std::wstring mode = count > 1 ? arguments[1] : L"--open-report";
    bool quiet = count > 2 && !wcscmp(arguments[2], L"--quiet"); LocalFree(arguments);
    if(mode == L"--show-report") { result = ShowReport(quiet); CoUninitialize(); return SUCCEEDED(result) ? 0 : 1; }
    if(mode == L"--test-activation" || mode == L"--test-rejection")
    {
        bool reject = mode == L"--test-rejection";
        ComPtr<INotificationActivationCallback> callback;
        result = CoCreateInstance(__uuidof(GoodreadsNotificationCallback), nullptr, CLSCTX_LOCAL_SERVER, IID_PPV_ARGS(&callback));
        if(SUCCEEDED(result)) result = callback->Activate(AppId, reject ? L"unsupported-action" : L"verify-open-report", nullptr, 0);
        bool passed = reject ? result == E_INVALIDARG : SUCCEEDED(result);
        Record(passed ? L"test-passed" : L"test-failed", L"client", result, false);
        callback.Reset(); CoUninitialize(); return passed ? 0 : 1;
    }
    if(mode != L"--toast-server" && mode != L"-Embedding")
    { result = Open(L"shortcut"); CoUninitialize(); return SUCCEEDED(result) ? 0 : 1; }
    Module<OutOfProc>::Create([] {});
    auto& module = Module<OutOfProc>::GetModule(); module.IncrementObjectCount();
    result = module.RegisterObjects();
    if(SUCCEEDED(result))
    {
        Record(L"server-ready", L"COM-server");
        UINT_PTR timeout = SetTimer(nullptr, 0, 90000, nullptr), finish = 0;
        MSG message;
        while(GetMessageW(&message, nullptr, 0, 0) > 0)
        {
            if(message.message == WM_APP + 1) { KillTimer(nullptr, timeout); finish = SetTimer(nullptr, 0, 500, nullptr); }
            if(message.message == WM_TIMER && (message.wParam == timeout || message.wParam == finish)) { if(!finish) Record(L"timed-out", L"COM-server", HRESULT_FROM_WIN32(ERROR_TIMEOUT)); break; }
            TranslateMessage(&message); DispatchMessageW(&message);
        }
        module.UnregisterObjects();
    }
    else Record(L"failed", L"register", result);
    module.DecrementObjectCount(); CoUninitialize(); return SUCCEEDED(result) ? 0 : 1;
}
