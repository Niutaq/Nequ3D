package main

import "os"

func coreAddress() string {
	if address := os.Getenv("NEQU3D_CORE_ADDR"); address != "" {
		return address
	}
	return "127.0.0.1:50051"
}
