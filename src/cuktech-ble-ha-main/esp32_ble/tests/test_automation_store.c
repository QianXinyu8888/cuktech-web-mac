#include "automation_store.h"
#include "nvs.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
static unsigned char blob[2][256]; static size_t size[2]; static int fail_commit,corrupt;
esp_err_t nvs_open(const char *n,int mode,nvs_handle_t *h) { (void)n; *h=1; return mode==NVS_READONLY&&!size[0]&&!size[1]?ESP_ERR_NVS_NOT_FOUND:ESP_OK; }
esp_err_t nvs_get_blob(nvs_handle_t h,const char *key,void *out,size_t *len) { (void)h;int i=!strcmp(key,"progress");if(!size[i])return ESP_ERR_NVS_NOT_FOUND; if(*len<size[i])return 2;memcpy(out,blob[i],size[i]);*len=size[i];if(corrupt)((unsigned char *)out)[0]^=1;return ESP_OK; }
esp_err_t nvs_set_blob(nvs_handle_t h,const char *key,const void *in,size_t len) { (void)h;int i=!strcmp(key,"progress");assert(len<=sizeof blob[i]);memcpy(blob[i],in,len);size[i]=len;return ESP_OK; }
esp_err_t nvs_commit(nvs_handle_t h) { (void)h;return fail_commit?2:ESP_OK; }
void nvs_close(nvs_handle_t h) { (void)h; }
int main(void) {
 AutoConfig c={0}, loaded={0}; for(int i=0;i<4;i++)c.ports[i].limit_mode=AUTO_ONCE;
 assert(automation_store_load(&loaded)==AUTO_STORE_EMPTY);
 c.ports[0].limit_wh=12; c.ports[1].permanent=true;
 assert(automation_store_save(&c));assert(automation_store_load(&loaded)==AUTO_STORE_LOADED);
 assert(loaded.ports[0].limit_wh==12 && loaded.ports[1].permanent);
 static AutoEngine before,after;auto_engine_init(&before,&c);before.ports[0].session_wh=4.25f;
 assert(automation_progress_save(&before));auto_engine_init(&after,&loaded);
 assert(automation_progress_load(&after)); assert(after.ports[0].session_wh==4.25f);
 assert(auto_restart_paused(&loaded.ports[0],&after.config.ports[0],true));
 after.config.ports[0].limit_wh=13; after.ports[0].session_wh=0;
 assert(automation_progress_load(&after)); assert(after.ports[0].session_wh==0);
 corrupt=1;assert(automation_store_load(&loaded)==AUTO_STORE_ERROR); assert(!automation_store_save(&c));corrupt=0;
 fail_commit=1;assert(!automation_store_save(&c));
 puts("automation storage tests passed");
}
