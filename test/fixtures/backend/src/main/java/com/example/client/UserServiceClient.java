package com.example.client;

import com.example.api.ApiPaths;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;

@FeignClient(name = "user-service", url = "${services.user.url}")
public interface UserServiceClient {
    @GetMapping("/api" + ApiPaths.USERS + "/{id}")
    String getUser(@PathVariable("id") Long id);

    @DeleteMapping("/api/users/{id}")
    void removeUser(@PathVariable("id") Long id);
}
