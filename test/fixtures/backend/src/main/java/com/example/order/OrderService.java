package com.example.order;

import com.example.client.ProductExchange;
import com.example.client.UserServiceClient;

public class OrderService {
    private final UserServiceClient users;
    private final ProductExchange products;

    public OrderService(UserServiceClient users, ProductExchange products) {
        this.users = users;
        this.products = products;
    }

    public String describe(Long userId, Long productId) {
        return users.getUser(userId) + products.product(productId);
    }
}
