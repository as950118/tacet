package com.example.client;

import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.annotation.HttpExchange;

@HttpExchange("/api/products")
public interface ProductExchange {
    @GetExchange("/{id}")
    String product(Long id);
}
