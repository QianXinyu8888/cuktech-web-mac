#include "http_guard.h"
#include <assert.h>
#include <stdio.h>
int main(void) {
 const char *ip="192.168.4.1";
 assert(http_guard_request(ip,"http://192.168.4.1","same-origin","application/json",true,ip,""));
 assert(http_guard_request("192.168.4.1:80","","","application/json; charset=utf-8",true,ip,""));
 assert(!http_guard_request("attacker.test","","","application/json",true,ip,""));
 assert(!http_guard_request(ip,"http://attacker.test","cross-site","text/plain",true,ip,""));
 assert(!http_guard_request(ip,"","cross-site","application/json",true,ip,""));
 assert(!http_guard_request(ip,"http://192.168.4.1","same-origin","text/plain",true,ip,""));
 assert(!http_guard_cloud_change("wss://a/api/device","wss://b/api/device","secret",NULL));
 assert(!http_guard_cloud_change("wss://a/api/device","wss://b/api/device","secret","****"));
 assert(!http_guard_cloud_change("wss://a/api/device","wss://b/api/device","secret","secret"));
 assert(http_guard_cloud_change("wss://a/api/device","wss://b/api/device","secret","new-secret"));
 puts("HTTP guard tests passed");
}
