#include "http_guard.h"
#include <string.h>
#include <strings.h>
#include <stdio.h>
static bool valid_host(const char *host,const char *ip) {
    if (!ip || !*ip || !strcmp(ip,"0.0.0.0")) return false;
    char with_port[32]; snprintf(with_port,sizeof with_port,"%s:80",ip);
    return !strcmp(host,ip)||!strcmp(host,with_port);
}
bool http_guard_request(const char *host,const char *origin,const char *fetch_site,const char *content_type,bool post,const char *ip1,const char *ip2) {
    if (!host || !(valid_host(host,ip1)||valid_host(host,ip2)))return false;
    if (origin && *origin) { char expected[48]; snprintf(expected,sizeof expected,"http://%s",host);if(strcmp(origin,expected))return false; }
    if (fetch_site && *fetch_site && strcmp(fetch_site,"same-origin") && strcmp(fetch_site,"none"))return false;
    if (post && (!content_type || strncasecmp(content_type,"application/json",16) || (content_type[16] && content_type[16]!=';' && content_type[16]!=' ')))return false;
    return true;
}
bool http_guard_cloud_change(const char *old_url,const char *new_url,const char *old_token,const char *submitted_token) {
    if(!old_url||!new_url||!old_token)return false;
    if(!strcmp(old_url,new_url))return true;
    return submitted_token && *submitted_token && !strstr(submitted_token,"****") && strcmp(submitted_token,old_token);
}
