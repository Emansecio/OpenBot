#include <windows.h>
#include <wincrypt.h>
#include <node_api.h>

static napi_value dpapi_error(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

static napi_value dpapi_protect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) return dpapi_error(env, "expected one Buffer");
  void* input = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &input, &length) != napi_ok || length > UINT32_MAX) return dpapi_error(env, "expected a valid Buffer");
  DATA_BLOB in{static_cast<DWORD>(length), static_cast<BYTE*>(input)};
  DATA_BLOB out{};
  if (!CryptProtectData(&in, L"OpenBot CurrentUser secret", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) return dpapi_error(env, "CryptProtectData failed");
  napi_value result;
  napi_status status = napi_create_buffer_copy(env, out.cbData, out.pbData, nullptr, &result);
  SecureZeroMemory(out.pbData, out.cbData);
  LocalFree(out.pbData);
  if (status != napi_ok) return dpapi_error(env, "napi_create_buffer_copy failed");
  return result;
}

static napi_value dpapi_unprotect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) return dpapi_error(env, "expected one Buffer");
  void* input = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &input, &length) != napi_ok || length > UINT32_MAX) return dpapi_error(env, "expected a valid Buffer");
  DATA_BLOB in{static_cast<DWORD>(length), static_cast<BYTE*>(input)};
  DATA_BLOB out{};
  if (!CryptUnprotectData(&in, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) return dpapi_error(env, "CryptUnprotectData failed");
  napi_value result;
  napi_status status = napi_create_buffer_copy(env, out.cbData, out.pbData, nullptr, &result);
  SecureZeroMemory(out.pbData, out.cbData);
  LocalFree(out.pbData);
  if (status != napi_ok) return dpapi_error(env, "napi_create_buffer_copy failed");
  return result;
}

NAPI_MODULE_INIT() {
  napi_value protect_fn;
  napi_value unprotect_fn;
  if (napi_create_function(env, "protect", NAPI_AUTO_LENGTH, dpapi_protect, nullptr, &protect_fn) != napi_ok) return nullptr;
  if (napi_create_function(env, "unprotect", NAPI_AUTO_LENGTH, dpapi_unprotect, nullptr, &unprotect_fn) != napi_ok) return nullptr;
  if (napi_set_named_property(env, exports, "protect", protect_fn) != napi_ok) return nullptr;
  if (napi_set_named_property(env, exports, "unprotect", unprotect_fn) != napi_ok) return nullptr;
  return exports;
}
