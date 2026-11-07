#include "automation_store.h"
#include "nvs.h"
#include <string.h>
#include <math.h>
typedef struct { uint32_t magic,version; AutoConfig config; } StoredAutomation;
static const uint32_t MAGIC=0x43554b41;
AutoStoreLoad automation_store_load(AutoConfig *config) {
 nvs_handle_t handle;
 esp_err_t error=nvs_open("automation",NVS_READONLY,&handle);
 if(error==ESP_ERR_NVS_NOT_FOUND)return AUTO_STORE_EMPTY;
 if(error!=ESP_OK)return AUTO_STORE_ERROR;
 StoredAutomation blob={0};size_t length=sizeof blob;
 error=nvs_get_blob(handle,"rules",&blob,&length);nvs_close(handle);
 if(error==ESP_ERR_NVS_NOT_FOUND)return AUTO_STORE_EMPTY;
 if(error!=ESP_OK||length!=sizeof blob||blob.magic!=MAGIC||blob.version!=1||!auto_config_valid(&blob.config))return AUTO_STORE_ERROR;
 *config=blob.config;return AUTO_STORE_LOADED;
}
bool automation_store_save(const AutoConfig *config) {
 if(!auto_config_valid(config))return false;
 StoredAutomation blob={.magic=MAGIC,.version=1},verified={0};
 /* Zero padding for a stable, verifiable representation. */
 for(unsigned i=0;i<4;++i) {
  blob.config.ports[i].limit_wh=config->ports[i].limit_wh;blob.config.ports[i].limit_mode=config->ports[i].limit_mode;
  blob.config.ports[i].full_mode=config->ports[i].full_mode;blob.config.ports[i].permanent=config->ports[i].permanent;
 }
 nvs_handle_t handle;
 if(nvs_open("automation",NVS_READWRITE,&handle)!=ESP_OK)return false;
 esp_err_t error=nvs_set_blob(handle,"rules",&blob,sizeof blob);
 if(error==ESP_OK)error=nvs_commit(handle);
 size_t length=sizeof verified;
 if(error==ESP_OK)error=nvs_get_blob(handle,"rules",&verified,&length);
 nvs_close(handle);
 return error==ESP_OK&&length==sizeof blob&&!memcmp(&blob,&verified,sizeof blob);
}
typedef struct { uint32_t magic,version; AutoConfig config; float wh[4]; } StoredProgress;
bool automation_progress_save(const AutoEngine *engine) {
 if(!engine || !auto_config_valid(&engine->config))return false;
 StoredProgress blob={.magic=0x43554b50,.version=1},check={0};
 for(unsigned i=0;i<4;i++) {
  blob.config.ports[i].limit_wh=engine->config.ports[i].limit_wh;
  blob.config.ports[i].limit_mode=engine->config.ports[i].limit_mode;
  blob.config.ports[i].full_mode=engine->config.ports[i].full_mode;
  blob.config.ports[i].permanent=engine->config.ports[i].permanent;
  blob.wh[i]=engine->ports[i].session_wh;
 }
 nvs_handle_t handle; if(nvs_open("automation",NVS_READWRITE,&handle)!=ESP_OK)return false;
 esp_err_t error=nvs_set_blob(handle,"progress",&blob,sizeof blob);
 if(error==ESP_OK)error=nvs_commit(handle);
 size_t length=sizeof check;
 if(error==ESP_OK)error=nvs_get_blob(handle,"progress",&check,&length);
 nvs_close(handle);return error==ESP_OK && length==sizeof blob && !memcmp(&blob,&check,sizeof blob);
}
bool automation_progress_load(AutoEngine *engine) {
 if(!engine)return false;
 nvs_handle_t handle; if(nvs_open("automation",NVS_READONLY,&handle)!=ESP_OK)return false;
 StoredProgress blob={0};size_t length=sizeof blob;
 esp_err_t error=nvs_get_blob(handle,"progress",&blob,&length);nvs_close(handle);
 if(error!=ESP_OK||length!=sizeof blob||blob.magic!=0x43554b50||blob.version!=1||!auto_config_valid(&blob.config))return false;
 for(unsigned i=0;i<4;i++) {
  const AutoRule *a=&blob.config.ports[i],*b=&engine->config.ports[i];
  if(a->limit_wh==b->limit_wh && a->limit_mode==b->limit_mode && isfinite(blob.wh[i]) && blob.wh[i]>=0)
   engine->ports[i].session_wh=blob.wh[i];
 }
 return true;
}
